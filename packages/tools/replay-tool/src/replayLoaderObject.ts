/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import type {
	ICodeDetailsLoader,
	IFluidCodeDetails,
	IFluidCodeDetailsComparer,
	IFluidModule,
	IFluidModuleWithDetails,
	IProvideRuntimeFactory,
} from "@fluidframework/container-definitions/internal";
import type { IRequest } from "@fluidframework/core-interfaces";
import type { IResolvedUrl, IUrlResolver } from "@fluidframework/driver-definitions/internal";

/**
 * URL Resolver for the replay tool.
 */
export class ReplayUrlResolver implements IUrlResolver {
	constructor(private readonly cache?: Map<string, IResolvedUrl>) {}

	public async resolve(request: IRequest): Promise<IResolvedUrl> {
		if (!this.cache.has(request.url)) {
			// eslint-disable-next-line @typescript-eslint/no-base-to-string
			throw new Error(`ContainerUrlResolver can't resolve ${request}`);
		}
		return this.cache.get(request.url);
	}

	public async getAbsoluteUrl(
		resolvedUrl: IResolvedUrl,
		relativeUrl: string,
	): Promise<string> {
		throw new Error("Not implemented");
	}
}

/** Simple code loader that loads the runtime factory provided during creation. */
export class ReplayCodeLoader implements ICodeDetailsLoader, IFluidCodeDetailsComparer {
	private readonly fluidModule: IFluidModule;

	constructor(runtimeFactory: IProvideRuntimeFactory) {
		this.fluidModule = { fluidExport: runtimeFactory };
	}

	public get IFluidCodeDetailsComparer(): IFluidCodeDetailsComparer {
		return this;
	}

	public async load(source: IFluidCodeDetails): Promise<IFluidModuleWithDetails> {
		return {
			module: this.fluidModule,
			details: source,
		};
	}

	public async satisfies(
		candidate: IFluidCodeDetails,
		constraint: IFluidCodeDetails,
	): Promise<boolean> {
		return true;
	}

	public async compare(
		a: IFluidCodeDetails,
		b: IFluidCodeDetails,
	): Promise<number | undefined> {
		return undefined;
	}
}
