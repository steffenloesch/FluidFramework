/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type { IFluidHandle, ITelemetryBaseLogger } from "@fluidframework/core-interfaces";
import { assert } from "@fluidframework/core-utils/internal";
import type {
	IFluidDataStoreRuntime,
	IChannelStorageService,
} from "@fluidframework/datastore-definitions/internal";
import type { ISequencedDocumentMessage } from "@fluidframework/driver-definitions/internal";
import {
	BaseSegment,
	Client,
	type IJSONSegment,
	type IMergeTreeDeltaCallbackArgs,
	type IMergeTreeDeltaOpArgs,
	type IMergeTreeMaintenanceCallbackArgs,
	type ISegment,
	MergeTreeDeltaType,
	MergeTreeMaintenanceType,
	segmentIsRemoved,
	type IMergeTreeInsertMsg,
	type IMergeTreeRemoveMsg,
} from "@fluidframework/merge-tree/internal";
import type { ISummaryTreeWithStats } from "@fluidframework/runtime-definitions/internal";
import {
	ObjectStoragePartition,
	SummaryTreeBuilder,
} from "@fluidframework/runtime-utils/internal";
import type { IFluidSerializer } from "@fluidframework/shared-object-base/internal";
import { createChildLogger } from "@fluidframework/telemetry-utils/internal";

import { HandleCache } from "./handlecache.js";
import { Handle, HandleTable, isHandleValid } from "./handletable.js";
import { deserializeBlob } from "./serialization.js";
import type { VectorUndoProvider } from "./undoprovider.js";

const enum SnapshotPath {
	segments = "segments",
	handleTable = "handleTable",
}

type PermutationSegmentSpec = [number, number];

export class PermutationSegment extends BaseSegment {
	public static readonly typeString: string = "PermutationSegment";
	private _start = Handle.unallocated;

	public static fromJSONObject(spec: IJSONSegment): PermutationSegment {
		const [length, start] = spec as PermutationSegmentSpec;
		return new PermutationSegment(length, start);
	}

	public readonly type = PermutationSegment.typeString;

	constructor(length: number, start = Handle.unallocated) {
		super();
		this._start = start;
		this.cachedLength = length;
	}

	public get start(): Handle {
		return this._start;
	}
	public set start(value: Handle) {
		assert(
			this._start === Handle.unallocated,
			0x024 /* "Start of PermutationSegment already allocated!" */,
		);
		assert(
			isHandleValid(value),
			0x025 /* "Trying to set start of PermutationSegment to invalid handle!" */,
		);

		this._start = value;
	}

	public reset(): void {
		this._start = Handle.unallocated;
	}

	public toJSONObject(): number[] {
		return [this.cachedLength, this.start];
	}

	public clone(start = 0, end = this.cachedLength): PermutationSegment {
		const b = new PermutationSegment(
			/* length: */ end - start,
			/* start: */ this.start + start,
		);
		this.cloneInto(b);
		return b;
	}

	public canAppend(segment: ISegment): boolean {
		const asPerm = segment as PermutationSegment;

		return this.start === Handle.unallocated
			? asPerm.start === Handle.unallocated
			: asPerm.start === this.start + this.cachedLength;
	}

	protected createSplitSegmentAt(pos: number): PermutationSegment {
		assert(
			0 < pos && pos < this.cachedLength,
			0x026 /* "Trying to split segment at out-of-bounds position!" */,
		);

		const leafSegment = new PermutationSegment(
			/* length: */ this.cachedLength - pos,
			/* start: */ this.start === Handle.unallocated ? Handle.unallocated : this.start + pos,
		);

		this.cachedLength = pos;

		return leafSegment;
	}

	public toString(): string {
		return this.start === Handle.unallocated
			? `<${this.cachedLength} empty>`
			: `<${this.cachedLength}: ${this.start}..${this.start + this.cachedLength - 1}>`;
	}
}

export class PermutationVector extends Client {
	private handleTable = new HandleTable<never>(); // Tracks available storage handles for rows.
	public readonly handleCache = new HandleCache(this);
	public undo: VectorUndoProvider | undefined;

	constructor(
		path: string,
		logger: ITelemetryBaseLogger,
		runtime: IFluidDataStoreRuntime,
		private readonly deltaCallback: (
			position: number,
			numRemoved: number,
			numInserted: number,
		) => void,
		private readonly handlesRecycledCallback: (handles: Handle[]) => void,
		getMinInFlightRefSeq: () => number | undefined,
	) {
		super(
			PermutationSegment.fromJSONObject,
			createChildLogger({ logger, namespace: `Matrix.${path}.MergeTreeClient` }),
			{
				...runtime.options,
				newMergeTreeSnapshotFormat: true, // Force new snapshot format as it's generally more efficient for matrices.
			},
			getMinInFlightRefSeq,
		);

		this.on("delta", this.onDelta);
		this.on("maintenance", this.onMaintenance);
	}

	public insert(start: number, length: number): IMergeTreeInsertMsg | undefined {
		return this.insertSegmentLocal(start, new PermutationSegment(length));
	}

	public remove(start: number, length: number): IMergeTreeRemoveMsg {
		return this.removeRangeLocal(start, start + length);
	}

	public getMaybeHandle(pos: number): Handle {
		assert(
			0 <= pos && pos < this.getLength(),
			0x027 /* "Trying to get handle of out-of-bounds position!" */,
		);

		return this.handleCache.getHandle(pos);
	}

	public getAllocatedHandle(pos: number): Handle {
		let handle = this.getMaybeHandle(pos);
		if (isHandleValid(handle)) {
			return handle;
		}

		this.walkSegments(
			(segment) => {
				const asPerm = segment as PermutationSegment;
				asPerm.start = handle = this.handleTable.allocate();
				return true;
			},
			pos,
			pos + 1,
			/* accum: */ undefined,
			/* splitRange: */ true,
		);

		this.handleCache.addHandle(pos, handle);

		return handle;
	}

	public adjustPosition(
		posToAdjust: number,
		op: ISequencedDocumentMessage,
	): { pos: number | undefined; handle: Handle } {
		const segOff = this.getContainingSegment<PermutationSegment>(posToAdjust, {
			referenceSequenceNumber: op.referenceSequenceNumber,
			clientId: op.clientId,
		});

		assert(
			segOff !== undefined,
			0xbac /* segment must be available for operations in the collab window */,
		);
		const { segment, offset } = segOff;

		if (segmentIsRemoved(segment)) {
			// this case is tricky. the segment which the row or column data is remove
			// but an op before that remove references a cell. we still want to apply
			// the op, as the row/col could become active again in the case where
			// the remove was local and it get's rolled back. so we allocate a handle
			// for the row/col if not allocated, but don't put it in the cache
			// as the cache can only contain live positions.
			let handle = segment.start;
			if (!isHandleValid(handle)) {
				this.walkSegments(
					(s) => {
						const asPerm = s as PermutationSegment;
						asPerm.start = handle = this.handleTable.allocate();
						return true;
					},
					posToAdjust,
					posToAdjust + 1,
					/* accum: */ undefined,
					/* splitRange: */ true,
					op,
				);
			}

			return { handle, pos: undefined };
		} else {
			const pos = this.getPosition(segment) + offset;
			return {
				pos,
				handle: this.getAllocatedHandle(pos),
			};
		}
	}

	public handleToPosition(handle: Handle, localSeq = this.getCollabWindow().localSeq): number {
		assert(
			localSeq <= this.getCollabWindow().localSeq,
			0x028 /* "'localSeq' for op being resubmitted must be <= the 'localSeq' of the last submitted op." */,
		);

		// TODO: In theory, the MergeTree should be able to map the (position, refSeq, localSeq) from
		//       the original operation to the current position for undo/redo scenarios.  This is probably the
		//       ideal solution, as we would no longer need to store row/col handles in the op metadata.
		//
		//       Failing that, we could avoid the O(n) search below by building a temporary map in the
		//       opposite direction from the handle to either it's current position or segment + offset
		//       and reuse it for the duration of undo/redo.  (Ideally, we would know when the undo/redo
		//       ended so we could discard this map.)
		//
		//       If we find that we frequently need a reverse handle -> position lookup, we could maintain
		//       one using the Tiny-Calc adjust tree.
		let containingSegment!: PermutationSegment;
		let containingOffset: number;

		this.walkAllSegments((segment) => {
			const { start, cachedLength } = segment as PermutationSegment;

			// If the segment is unallocated, skip it.
			if (!isHandleValid(start)) {
				return true;
			}

			const end = start + cachedLength;

			if (start <= handle && handle < end) {
				containingSegment = segment as PermutationSegment;
				containingOffset = handle - start;
				return false;
			}

			return true;
		});

		// We are guaranteed to find the handle in the PermutationVector, even if the corresponding
		// row/col has been removed, because handles are not recycled until the containing segment
		// is unlinked from the MergeTree.
		//
		// Therefore, either a row/col removal has been ACKed, in which case there will be no pending
		// ops that reference the stale handle, or the removal is unACKed, in which case the handle
		// has not yet been recycled.

		assert(
			isHandleValid(containingSegment.start),
			0x029 /* "Invalid handle at start of containing segment!" */,
		);

		// Once we know the current position of the handle, we can use the MergeTree to get the segment
		// containing this position and use 'findReconnectionPosition' to adjust for the local ops that
		// have not yet been submitted.

		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
		return this.findReconnectionPosition(containingSegment, localSeq) + containingOffset!;
	}

	// Constructs an ISummaryTreeWithStats for the cell data.
	public summarize(
		runtime: IFluidDataStoreRuntime,
		handle: IFluidHandle,
		serializer: IFluidSerializer,
	): ISummaryTreeWithStats {
		const builder = new SummaryTreeBuilder();
		builder.addWithStats(
			SnapshotPath.segments,
			super.summarize(runtime, handle, serializer, /* catchUpMsgs: */ []),
		);
		builder.addBlob(
			SnapshotPath.handleTable,
			serializer.stringify(this.handleTable.getSummaryContent(), handle),
		);
		return builder.getSummaryTree();
	}

	public async load(
		runtime: IFluidDataStoreRuntime,
		storage: IChannelStorageService,
		serializer: IFluidSerializer,
	): Promise<{
		catchupOpsP: Promise<ISequencedDocumentMessage[]>;
	}> {
		const handleTableData = (await deserializeBlob(
			storage,
			SnapshotPath.handleTable,
			serializer,
			// Cast is needed since the (de)serializer returns content of type `any`.
		)) as Handle[];

		this.handleTable = HandleTable.load<never>(handleTableData);

		return super.load(
			runtime,
			new ObjectStoragePartition(storage, SnapshotPath.segments),
			serializer,
		);
	}

	private readonly onDelta = (
		opArgs: IMergeTreeDeltaOpArgs,
		deltaArgs: IMergeTreeDeltaCallbackArgs,
	): void => {
		// Apply deltas in descending order to prevent positions from shifting.
		const ranges = deltaArgs.deltaSegments
			.map(({ segment }) => ({
				segment: segment as PermutationSegment,
				position: this.getPosition(segment),
			}))
			.sort((left, right) => left.position - right.position);

		const isLocal = opArgs.sequencedMessage === undefined;

		// Notify the undo provider, if any is attached.
		if (this.undo !== undefined && isLocal) {
			this.undo.record(deltaArgs);
		}

		switch (deltaArgs.operation) {
			case MergeTreeDeltaType.INSERT: {
				// Pass 1: Perform any internal maintenance first to avoid reentrancy.
				for (const { segment, position } of ranges) {
					if (opArgs.rollback !== true) {
						// HACK: We need to include the allocated handle in the segment's JSON representation
						//       for snapshots, but need to ignore the remote client's handle allocations when
						//       processing remote ops.
						segment.reset();
					}

					this.handleCache.itemsChanged(
						position,
						/* deleteCount: */ 0,
						/* insertCount: */ segment.cachedLength,
					);
				}

				// Pass 2: Notify the 'deltaCallback', which may involve callbacks into user code.
				for (const { segment, position } of ranges) {
					this.deltaCallback(
						position,
						/* numRemoved: */ 0,
						/* numInserted: */ segment.cachedLength,
					);
				}
				break;
			}
			case MergeTreeDeltaType.REMOVE: {
				// Pass 1: Perform any internal maintenance first to avoid reentrancy.
				for (const { segment, position } of ranges) {
					this.handleCache.itemsChanged(
						position /* deleteCount: */,
						segment.cachedLength,
						/* insertCount: */ 0,
					);
				}

				// Pass 2: Notify the 'deltaCallback', which may involve callbacks into user code.
				for (const { segment, position } of ranges) {
					this.deltaCallback(
						position,
						/* numRemoved: */ segment.cachedLength,
						/* numInsert: */ 0,
					);
				}
				break;
			}
			default: {
				throw new Error("Unhandled MergeTreeDeltaType");
			}
		}
	};

	private readonly onMaintenance = (args: IMergeTreeMaintenanceCallbackArgs): void => {
		if (args.operation === MergeTreeMaintenanceType.UNLINK) {
			let freed: number[] = [];

			for (const { segment } of args.deltaSegments) {
				const asPerm = segment as PermutationSegment;
				if (isHandleValid(asPerm.start)) {
					// Note: Using the spread operator with `.splice()` can exhaust the stack.
					// eslint-disable-next-line unicorn/prefer-spread
					freed = freed.concat(
						Array.from({ length: asPerm.cachedLength })
							.fill(0)
							.map((value, index) => index + asPerm.start),
					);
				}
			}

			// Notify matrix that handles are about to be freed.  The matrix is responsible for clearing
			// the rows/cols prior to free to ensure recycled row/cols are initially empty.
			this.handlesRecycledCallback(freed);

			// Now that the physical storage has been cleared, add the recycled handles back to the free pool.
			for (const handle of freed) {
				this.handleTable.free(handle);
			}
		}
	};

	public toString(): string {
		const s: string[] = [];

		this.walkSegments((segment) => {
			// eslint-disable-next-line @typescript-eslint/no-base-to-string
			s.push(`${segment}`);
			return true;
		});

		return s.join("");
	}
}

export function reinsertSegmentIntoVector(
	vector: PermutationVector,
	pos: number,
	spec: IJSONSegment,
): {
	op: IMergeTreeInsertMsg | undefined;
	inserted: PermutationSegment;
} {
	const original = PermutationSegment.fromJSONObject(spec);

	// (Re)insert the removed number of rows at the original position.
	const op = vector.insertSegmentLocal(pos, original);
	const inserted = vector.getContainingSegment(pos)?.segment as PermutationSegment;

	// we reuse the original handle here
	// so if cells exist, they can be found, and re-inserted
	if (isHandleValid(original.start)) {
		inserted.start = original.start;
	}

	// Invalidate the handleCache in case it was populated during the 'rowsChanged'
	// callback, which occurs before the handle span is populated.
	vector.handleCache.itemsChanged(
		pos,
		/* removedCount: */ 0,
		/* insertedCount: */ inserted.cachedLength,
	);
	return { op, inserted };
}
