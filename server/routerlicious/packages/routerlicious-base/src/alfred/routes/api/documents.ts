/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import * as crypto from "crypto";

import { ScopeType } from "@fluidframework/protocol-definitions";
import {
	getBooleanParam,
	validateRequestParams,
	handleResponse,
} from "@fluidframework/server-services";
import {
	convertFirstSummaryWholeSummaryTreeToSummaryTree,
	type IAlfredTenant,
	type ISession,
	NetworkError,
	DocDeleteScopeType,
	TokenRevokeScopeType,
	createFluidServiceNetworkError,
	InternalErrorCode,
} from "@fluidframework/server-services-client";
import type {
	IDocumentStorage,
	IThrottler,
	ITenantManager,
	ICache,
	IDocumentRepository,
	ITokenRevocationManager,
	IRevokeTokenOptions,
	IRevokedTokenChecker,
	IClusterDrainingChecker,
	IDenyList,
} from "@fluidframework/server-services-core";
import {
	getLumberBaseProperties,
	LumberEventName,
	Lumberjack,
	type Lumber,
} from "@fluidframework/server-services-telemetry";
import {
	verifyStorageToken,
	getCreationToken,
	throttle,
	type IThrottleMiddlewareOptions,
	getParam,
	validateTokenScopeClaims,
	getBooleanFromConfig,
	getTelemetryContextPropertiesWithHttpInfo,
	denyListMiddleware,
} from "@fluidframework/server-services-utils";
import { type Request, Router } from "express";
import type { RequestHandler } from "express-serve-static-core";
import type { Provider } from "nconf";
import { v4 as uuid } from "uuid";
import winston from "winston";

import {
	Constants,
	generateCacheKey,
	getSession,
	setGetSessionResultInCache,
	StageTrace,
} from "../../../utils";
import type { IDocumentDeleteService } from "../../services";

/**
 * Response body shape for modern clients that can handle object responses.
 * @internal
 */
interface ICreateDocumentResponseBody {
	/**
	 * The id of the created document.
	 */
	readonly id: string;
	/**
	 * The access token for the created document.
	 * When this is provided, the client should use this token to connect to the document.
	 * Otherwise, if not provided, the client will need to generate a new token using the provided document id.
	 * @privateRemarks TODO: This is getting generated multiple times. We should generate it once and reuse it.
	 */
	readonly token?: string;
	/**
	 * The session information for the created document.
	 * When this is provided, the client should use this session information to connect to the document in the correct location.
	 * Otherwise, if not provided, the client will need to discover the correct location using the getSession API or continue using the
	 * original location used when creating the document.
	 */
	readonly session?: ISession;
}

async function generateCreateDocumentResponseBody(
	request: Request,
	tenantManager: ITenantManager,
	documentId: string,
	tenantId: string,
	generateToken: boolean,
	enableDiscovery: boolean,
	sessionInfo: {
		externalOrdererUrl: string;
		externalHistorianUrl: string;
		externalDeltaStreamUrl: string;
		messageBrokerId?: string;
	},
	isEphemeral: boolean,
	redisCacheForGetSession?: ICache,
	ephemeralDocumentTTLSec?: number,
	sessionCacheTTLSec?: number,
): Promise<ICreateDocumentResponseBody> {
	const authorizationHeader = request.header("Authorization");
	let newDocumentAccessToken: string | undefined;
	if (generateToken && authorizationHeader !== undefined) {
		// Generate creation token given a jwt from header
		const tokenRegex = /Basic (.+)/;
		const tokenMatch = tokenRegex.exec(authorizationHeader);
		const token = tokenMatch !== null ? tokenMatch[1] : undefined;
		if (token === undefined) {
			throw new NetworkError(400, "Authorization header is missing or malformed");
		}
		newDocumentAccessToken = await getCreationToken(tenantManager, token, documentId);
	}
	let newDocumentSession: ISession | undefined;
	if (enableDiscovery) {
		// Session information
		const session: ISession = {
			ordererUrl: sessionInfo.externalOrdererUrl,
			historianUrl: sessionInfo.externalHistorianUrl,
			deltaStreamUrl: sessionInfo.externalDeltaStreamUrl,
			// Indicate to consumer that session was newly created.
			isSessionAlive: false,
			isSessionActive: false,
		};
		// if undefined and added directly to the session object - will be serialized as null in mongo which is undesirable
		if (sessionInfo.messageBrokerId) {
			session.messageBrokerId = sessionInfo.messageBrokerId;
		}
		newDocumentSession = session;
		if (redisCacheForGetSession) {
			// If ephemeral, set TTL to 95% of ephemeralDocumentTTLSec
			// to account for latency in reaching here.
			const ephemeralDocumentTTLWithLatencyMargin = ephemeralDocumentTTLSec
				? Math.floor(ephemeralDocumentTTLSec * 0.95)
				: undefined;
			// Set session information in cache
			await setGetSessionResultInCache(
				tenantId,
				documentId,
				session,
				redisCacheForGetSession,
				isEphemeral ? ephemeralDocumentTTLWithLatencyMargin : sessionCacheTTLSec,
			);
		}
	}
	return {
		id: documentId,
		token: newDocumentAccessToken,
		session: newDocumentSession,
	};
}

export function create(
	storage: IDocumentStorage,
	appTenants: IAlfredTenant[],
	tenantThrottlers: Map<string, IThrottler>,
	clusterThrottlers: Map<string, IThrottler>,
	singleUseTokenCache: ICache,
	config: Provider,
	tenantManager: ITenantManager,
	documentRepository: IDocumentRepository,
	documentDeleteService: IDocumentDeleteService,
	tokenRevocationManager?: ITokenRevocationManager,
	revokedTokenChecker?: IRevokedTokenChecker,
	clusterDrainingChecker?: IClusterDrainingChecker,
	redisCacheForGetSession?: ICache,
	denyList?: IDenyList,
): Router {
	const router: Router = Router();
	const externalOrdererUrl: string = config.get("worker:serverUrl");
	const externalHistorianUrl: string = config.get("worker:blobStorageUrl");
	const externalDeltaStreamUrl: string =
		config.get("worker:deltaStreamUrl") || externalOrdererUrl;
	const messageBrokerId: string | undefined =
		config.get("kafka:lib:eventHubConnString") !== undefined
			? crypto
					.createHash("sha1")
					.update(config.get("kafka:lib:endpoint") ?? "")
					.digest("hex")
			: undefined;
	const sessionStickinessDurationMs: number | undefined = config.get(
		"alfred:sessionStickinessDurationMs",
	);
	const ephemeralDocumentTTLSec: number | undefined = config.get(
		"storage:ephemeralDocumentTTLSec",
	);
	const sessionCacheTTLSec: number | undefined = config.get("alfred:sessionCacheTTLSec");
	const sessionCacheTTLForDeletedDocumentsSec: number | undefined = config.get(
		"alfred:sessionCacheTTLForDeletedDocumentsSec",
	);

	const ignoreEphemeralFlag: boolean = config.get("alfred:ignoreEphemeralFlag") ?? true;
	// Whether to enforce server-generated document ids in create doc flow
	const enforceServerGeneratedDocumentId: boolean =
		config.get("alfred:enforceServerGeneratedDocumentId") ?? false;

	// Throttling logic for per-tenant rate-limiting at the HTTP route level
	const tenantThrottleOptions: Partial<IThrottleMiddlewareOptions> = {
		throttleIdPrefix: (req) => getParam(req.params, "tenantId") || appTenants[0].id,
		throttleIdSuffix: Constants.alfredRestThrottleIdSuffix,
	};
	const generalTenantThrottler = tenantThrottlers.get(Constants.generalRestCallThrottleIdPrefix);

	const createDocTenantThrottleOptions: Partial<IThrottleMiddlewareOptions> = {
		throttleIdPrefix: (req) => getParam(req.params, "tenantId") || appTenants[0].id,
		throttleIdSuffix: Constants.createDocThrottleIdPrefix,
	};
	const getSessionTenantThrottleOptions: Partial<IThrottleMiddlewareOptions> = {
		throttleIdPrefix: (req) => getParam(req.params, "tenantId") || appTenants[0].id,
		throttleIdSuffix: Constants.getSessionThrottleIdPrefix,
	};

	// Throttling logic for per-cluster rate-limiting at the HTTP route level
	const createDocClusterThrottleOptions: Partial<IThrottleMiddlewareOptions> = {
		throttleIdPrefix: Constants.createDocThrottleIdPrefix,
		throttleIdSuffix: Constants.alfredRestThrottleIdSuffix,
	};
	const getSessionClusterThrottleOptions: Partial<IThrottleMiddlewareOptions> = {
		throttleIdPrefix: Constants.getSessionThrottleIdPrefix,
		throttleIdSuffix: Constants.alfredRestThrottleIdSuffix,
	};

	// Jwt token cache
	const enableJwtTokenCache: boolean = getBooleanFromConfig(
		"alfred:jwtTokenCache:enable",
		config,
	);

	const defaultTokenValidationOptions = {
		requireDocumentId: true,
		ensureSingleUseToken: false,
		singleUseTokenCache: undefined,
		enableTokenCache: enableJwtTokenCache,
		tokenCache: singleUseTokenCache,
		revokedTokenChecker,
	};

	const isHttpUsageCountingEnabled: boolean = config.get("usage:httpUsageCountingEnabled");

	router.get(
		"/:tenantId/:id",
		validateRequestParams("tenantId", "id"),
		throttle(generalTenantThrottler, winston, tenantThrottleOptions),
		verifyStorageToken(
			tenantManager,
			config,
			[ScopeType.DocRead],
			defaultTokenValidationOptions,
		),
		denyListMiddleware(denyList, true /* skipDocumentCheck */),
		(request, response, next) => {
			const tenantId = request.params.tenantId;
			const documentId = request.params.id;
			const documentP = storage
				.getDocument(tenantId ?? appTenants[0].id, documentId)
				.then((document) => {
					if (!document || document.scheduledDeletionTime) {
						throw new NetworkError(404, "Document not found.");
					}
					return document;
				});
			return handleResponse(documentP, response);
		},
	);

	/**
	 * Creates a new document with initial summary.
	 */
	router.post(
		"/:tenantId",
		validateRequestParams("tenantId"),
		throttle(
			clusterThrottlers.get(Constants.createDocThrottleIdPrefix),
			winston,
			createDocClusterThrottleOptions,
		),
		throttle(
			tenantThrottlers.get(Constants.createDocThrottleIdPrefix),
			winston,
			createDocTenantThrottleOptions,
			isHttpUsageCountingEnabled,
		),
		verifyStorageToken(tenantManager, config, [ScopeType.DocRead, ScopeType.DocWrite], {
			requireDocumentId: false,
			ensureSingleUseToken: true,
			singleUseTokenCache,
			enableTokenCache: enableJwtTokenCache,
			tokenCache: singleUseTokenCache,
			revokedTokenChecker,
		}),
		denyListMiddleware(denyList, true /* skipDocumentCheck */),
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		async (request, response, next) => {
			// Tenant and document
			const tenantId = request.params.tenantId;
			// Reject create document request if cluster is in draining process.
			if (
				clusterDrainingChecker &&
				(await clusterDrainingChecker
					.isClusterDraining({
						tenantId,
					})
					.catch((error) => {
						Lumberjack.error("Failed to get cluster draining status", undefined, error);
						return false;
					}))
			) {
				Lumberjack.info("Cluster is in draining process. Reject create document request.");
				const error = createFluidServiceNetworkError(503, {
					message: "Server is unavailable. Please retry create document later.",
					internalErrorCode: InternalErrorCode.ClusterDraining,
				});
				return handleResponse(Promise.reject(error), response);
			}
			// If enforcing server generated document id, ignore id parameter
			const id = enforceServerGeneratedDocumentId
				? uuid()
				: (request.body.id as string) || uuid();

			// Summary information
			const summary = request.body.enableAnyBinaryBlobOnFirstSummary
				? convertFirstSummaryWholeSummaryTreeToSummaryTree(request.body.summary)
				: request.body.summary;

			Lumberjack.info(
				`Whole summary on First Summary: ${request.body.enableAnyBinaryBlobOnFirstSummary}.`,
			);

			// Protocol state
			const {
				sequenceNumber,
				values,
				generateToken = false,
				isEphemeralContainer = false,
			} = request.body;

			const enableDiscovery: boolean = request.body.enableDiscovery ?? false;
			const isEphemeral: boolean =
				getBooleanParam(isEphemeralContainer) && !ignoreEphemeralFlag;

			const createP = storage.createDocument(
				tenantId,
				id,
				summary,
				sequenceNumber,
				crypto.randomBytes(4).toString("hex"),
				externalOrdererUrl,
				externalHistorianUrl,
				externalDeltaStreamUrl,
				values,
				enableDiscovery,
				isEphemeral,
				messageBrokerId,
			);

			// Handle backwards compatibility for older driver versions.
			// TODO: remove condition once old drivers are phased out and all clients can handle object response
			const clientAcceptsObjectResponse = enableDiscovery === true || generateToken === true;
			if (clientAcceptsObjectResponse) {
				const generateResponseBodyP = generateCreateDocumentResponseBody(
					request,
					tenantManager,
					id,
					tenantId,
					generateToken,
					enableDiscovery,
					{
						externalOrdererUrl,
						externalHistorianUrl,
						externalDeltaStreamUrl,
						messageBrokerId,
					},
					isEphemeral,
					redisCacheForGetSession,
					ephemeralDocumentTTLSec,
					sessionCacheTTLSec,
				);
				return handleResponse(
					Promise.all([createP, generateResponseBodyP]).then(
						([, responseBody]) => responseBody,
					),
					response,
					undefined,
					undefined,
					201,
				);
			} else {
				return handleResponse(
					createP.then(() => id),
					response,
					undefined,
					undefined,
					201,
				);
			}
		},
	);

	function verifyStorageTokenForGetSession(
		...args: Parameters<typeof verifyStorageToken>
	): RequestHandler {
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		return async (request, res, next) => {
			const VerifyStorageTokenMetric = Lumberjack.newLumberMetric(
				LumberEventName.VerifyStorageToken,
				undefined,
			);

			try {
				const result = verifyStorageToken(...args)(request, res, next);
				VerifyStorageTokenMetric.success("Token verified successfully.");
				return result;
			} catch (error) {
				VerifyStorageTokenMetric.error("Failed to verify token.", error);
				throw error;
			}
		};
	}

	/**
	 * Get the session information.
	 */
	router.get(
		"/:tenantId/session/:id",
		throttle(
			clusterThrottlers.get(Constants.getSessionThrottleIdPrefix),
			winston,
			getSessionClusterThrottleOptions,
		),
		throttle(
			tenantThrottlers.get(Constants.getSessionThrottleIdPrefix),
			winston,
			getSessionTenantThrottleOptions,
		),
		verifyStorageTokenForGetSession(
			tenantManager,
			config,
			[ScopeType.DocRead],
			defaultTokenValidationOptions,
		),
		denyListMiddleware(denyList, true /* skipDocumentCheck */),
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		async (request, response, next) => {
			const documentId = request.params.id;
			const tenantId = request.params.tenantId;

			const lumberjackProperties = getLumberBaseProperties(documentId, tenantId);
			const getSessionMetric: Lumber<LumberEventName.GetSession> = Lumberjack.newLumberMetric(
				LumberEventName.GetSession,
				lumberjackProperties,
			);
			// Tracks the different stages of getSessionMetric
			const connectionTrace = new StageTrace<string>("GetSession");
			// Reject get session request on existing, inactive sessions if cluster is in draining process.
			if (
				clusterDrainingChecker &&
				(await clusterDrainingChecker
					.isClusterDraining({
						tenantId,
					})
					.catch((error) => {
						Lumberjack.error("Failed to get cluster draining status", undefined, error);
						return false;
					}))
			) {
				Lumberjack.info("Cluster is in draining process. Reject get session request.");
				connectionTrace?.stampStage("ClusterIsDraining");
				const error = createFluidServiceNetworkError(503, {
					message: "Server is unavailable. Please retry session discovery later.",
					internalErrorCode: InternalErrorCode.ClusterDraining,
				});
				return handleResponse(Promise.reject(error), response);
			}
			connectionTrace?.stampStage("ClusterDrainingChecked");
			const readDocumentRetryDelay: number = config.get("getSession:readDocumentRetryDelay");
			const readDocumentMaxRetries: number = config.get("getSession:readDocumentMaxRetries");

			const session = getSession(
				externalOrdererUrl,
				externalHistorianUrl,
				externalDeltaStreamUrl,
				tenantId,
				documentId,
				documentRepository,
				sessionStickinessDurationMs,
				messageBrokerId,
				clusterDrainingChecker,
				ephemeralDocumentTTLSec,
				connectionTrace,
				readDocumentRetryDelay,
				readDocumentMaxRetries,
				redisCacheForGetSession,
				sessionCacheTTLSec,
				sessionCacheTTLForDeletedDocumentsSec,
			);

			const onSuccess = (result: ISession): void => {
				getSessionMetric.setProperty("connectTrace", connectionTrace);
				getSessionMetric.success("GetSession succeeded.");
			};

			const onError = (error: any): void => {
				getSessionMetric.setProperty("connectTrace", connectionTrace);
				getSessionMetric.error("GetSession failed.", error);
			};

			return handleResponse(
				session,
				response,
				false,
				undefined,
				undefined,
				onSuccess,
				onError,
			);
		},
	);

	/**
	 * Delete a document
	 */
	router.delete(
		"/:tenantId/document/:id",
		validateRequestParams("tenantId", "id"),
		validateTokenScopeClaims(DocDeleteScopeType),
		verifyStorageToken(
			tenantManager,
			config,
			[ScopeType.DocRead, ScopeType.DocWrite],
			defaultTokenValidationOptions,
		),
		denyListMiddleware(denyList, true /* skipDocumentCheck */),
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		async (request, response, next) => {
			const documentId = request.params.id;
			const tenantId = request.params.tenantId;
			const lumberjackProperties = getLumberBaseProperties(documentId, tenantId);
			Lumberjack.info(`Received document delete request.`, lumberjackProperties);

			let deleteSessionCacheP: Promise<boolean> | undefined;
			if (redisCacheForGetSession?.delete) {
				deleteSessionCacheP = redisCacheForGetSession
					.delete(generateCacheKey(tenantId, documentId))
					.catch((error) => {
						// Log error but don't fail the request
						Lumberjack.error(
							"Failed to delete getSession cache",
							lumberjackProperties,
							error,
						);
						return true;
					});
			}
			const deleteP = documentDeleteService.deleteDocument(tenantId, documentId);
			return handleResponse(
				Promise.all([deleteP, deleteSessionCacheP]).then(
					([deletePResponse]) => deletePResponse,
				),
				response,
				undefined,
				undefined,
				204,
			);
		},
	);

	/**
	 * Revoke an access token
	 */
	router.post(
		"/:tenantId/document/:id/revokeToken",
		validateRequestParams("tenantId", "id"),
		throttle(generalTenantThrottler, winston, tenantThrottleOptions),
		validateTokenScopeClaims(TokenRevokeScopeType),
		verifyStorageToken(
			tenantManager,
			config,
			[ScopeType.DocRead, ScopeType.DocWrite],
			defaultTokenValidationOptions,
		),
		denyListMiddleware(denyList, true /* skipDocumentCheck */),
		// eslint-disable-next-line @typescript-eslint/no-misused-promises
		async (request, response, next) => {
			const documentId = request.params.id;
			const tenantId = request.params.tenantId;
			const lumberjackProperties = getLumberBaseProperties(documentId, tenantId);
			Lumberjack.info(`Received token revocation request.`, lumberjackProperties);

			const tokenId = request.body.jti;
			if (!tokenId || typeof tokenId !== "string") {
				return handleResponse(
					Promise.reject(
						new NetworkError(400, `Missing or invalid jti in request body.`),
					),
					response,
				);
			}
			if (tokenRevocationManager) {
				const correlationId = getTelemetryContextPropertiesWithHttpInfo(
					request,
					response,
				).correlationId;
				if (!correlationId) {
					return handleResponse(
						Promise.reject(
							new NetworkError(400, `Missing correlationId in request headers.`),
						),
						response,
					);
				}
				const options: IRevokeTokenOptions = {
					correlationId,
				};
				const resultP = tokenRevocationManager.revokeToken(
					tenantId,
					documentId,
					tokenId,
					options,
				);
				return handleResponse(resultP, response);
			} else {
				return handleResponse(
					Promise.reject(
						new NetworkError(
							501,
							"Token revocation is not supported for now",
							false /* canRetry */,
							true /* isFatal */,
						),
					),
					response,
				);
			}
		},
	);
	return router;
}
