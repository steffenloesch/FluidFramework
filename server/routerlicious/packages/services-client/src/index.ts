/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

export {
	generateToken,
	generateUser,
	validateTokenClaims,
	validateTokenClaimsExpiration,
} from "./auth";
export {
	convertSortedNumberArrayToRanges,
	dedupeSortedArray,
	mergeKArrays,
	mergeSortedArrays,
} from "./array";
export {
	CorrelationIdHeaderName,
	DriverVersionHeaderName,
	LatestSummaryId,
	TelemetryContextHeaderName,
	CallingServiceHeaderName,
} from "./constants";
export {
	createFluidServiceNetworkError,
	type INetworkErrorDetails,
	InternalErrorCode,
	isNetworkError,
	NetworkError,
	throwFluidServiceNetworkError,
	convertAxiosErrorToNetorkError,
} from "./error";
export { choose, getRandomName } from "./generateNames";
export { GitManager } from "./gitManager";
export { Heap, type IHeapComparator } from "./heap";
export {
	getAuthorizationTokenFromCredentials,
	Historian,
	type ICredentials,
	parseToken,
} from "./historian";
export type { IAlfredTenant, ISession } from "./interfaces";
export { promiseTimeout } from "./promiseTimeout";
export { RestLessClient, RestLessFieldNames } from "./restLessClient";
export {
	BasicRestWrapper,
	RestWrapper,
	type IBasicRestWrapperMetricProps,
	setupAxiosInterceptorsForAbortSignals,
} from "./restWrapper";
export { defaultHash, getNextHash } from "./rollingHash";
export {
	canRead,
	canSummarize,
	canWrite,
	canRevokeToken,
	canDeleteDoc,
	TokenRevokeScopeType,
	DocDeleteScopeType,
} from "./scopes";
export {
	getQuorumTreeEntries,
	mergeAppAndProtocolTree,
	generateServiceProtocolEntries,
} from "./scribeHelper";
export type {
	ICreateRefParamsExternal,
	IExternalWriterConfig,
	IGetRefParamsExternal,
	IGitCache,
	IGitManager,
	IGitService,
	IHistorian,
	IPatchRefParamsExternal,
	ISummaryUploadManager,
} from "./storage";
export type {
	ExtendedSummaryObject,
	IEmbeddedSummaryHandle,
	INormalizedWholeSummary,
	ISummaryTree,
	IWholeFlatSummary,
	IWholeFlatSummaryBlob,
	IWholeFlatSummaryTree,
	IWholeFlatSummaryTreeEntry,
	IWholeFlatSummaryTreeEntryBlob,
	IWholeFlatSummaryTreeEntryTree,
	IWholeSummaryBlob,
	IWholeSummaryPayload,
	IWholeSummaryPayloadType,
	IWholeSummaryTree,
	IWholeSummaryTreeBaseEntry,
	IWholeSummaryTreeHandleEntry,
	IWholeSummaryTreeValueEntry,
	IWriteSummaryResponse,
	WholeSummaryTreeEntry,
	WholeSummaryTreeValue,
} from "./storageContracts";
export {
	buildTreePath,
	convertSummaryTreeToWholeSummaryTree,
	convertWholeFlatSummaryToSnapshotTreeAndBlobs,
	convertFirstSummaryWholeSummaryTreeToSummaryTree,
} from "./storageUtils";
export { SummaryTreeUploadManager } from "./summaryTreeUploadManager";
export {
	type ITimeoutContext,
	getGlobalTimeoutContext,
	setGlobalTimeoutContext,
} from "./timeoutContext";
export { getOrCreateRepository, getRandomInt } from "./utils";
export { WholeSummaryUploadManager } from "./wholeSummaryUploadManager";
export {
	type IAbortControllerContext,
	setGlobalAbortControllerContext,
	getGlobalAbortControllerContext,
} from "./abortControllerContext";
