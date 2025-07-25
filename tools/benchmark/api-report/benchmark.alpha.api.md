## Alpha API Report File for "@fluid-tools/benchmark"

> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).

```ts

/// <reference types="node" />

import type { Test } from 'mocha';

// @public
export function benchmark(args: BenchmarkArguments): Test;

// @public
export type BenchmarkArguments = Titled & (BenchmarkSyncArguments | BenchmarkAsyncArguments | CustomBenchmarkArguments);

// @public
export interface BenchmarkAsyncArguments extends BenchmarkAsyncFunction, BenchmarkOptions {
}

// @public
export interface BenchmarkAsyncFunction extends BenchmarkOptions {
    benchmarkFnAsync: () => Promise<unknown>;
}

// @public
export function benchmarkCustom(options: CustomBenchmarkOptions): Test;

// @public
export interface BenchmarkData {
    customData: CustomData;
    elapsedSeconds: number;
}

// @public
export interface BenchmarkDescription {
    category?: string;
    type?: BenchmarkType;
}

// @public
export interface BenchmarkError {
    error: string;
}

// @public
export function benchmarkMemory(testObject: IMemoryTestObject): Test;

// @public
export interface BenchmarkOptions extends MochaExclusiveOptions, HookArguments, BenchmarkTimingOptions, OnBatch, BenchmarkDescription {
}

// @public
export class BenchmarkReporter {
    constructor(outputDirectory?: string);
    recordResultsSummary(): void;
    recordSuiteResults(suiteName: string): void;
    recordTestResult(suiteName: string, testName: string, result: BenchmarkResult): void;
}

// @public
export type BenchmarkResult = BenchmarkError | BenchmarkData;

// @public (undocumented)
export type BenchmarkRunningOptions = BenchmarkSyncArguments | BenchmarkAsyncArguments | CustomBenchmarkArguments;

// @public
export interface BenchmarkSyncArguments extends BenchmarkSyncFunction, BenchmarkOptions {
}

// @public
export interface BenchmarkSyncFunction extends BenchmarkOptions {
    benchmarkFn: () => void;
}

// @public @sealed (undocumented)
export interface BenchmarkTimer<T> {
    // (undocumented)
    readonly iterationsPerBatch: number;
    // (undocumented)
    recordBatch(duration: number): boolean;
    timeBatch(callback: () => void): boolean;
    // (undocumented)
    readonly timer: Timer<T>;
}

// @public
export interface BenchmarkTimingOptions {
    maxBenchmarkDurationSeconds?: number;
    minBatchCount?: number;
    minBatchDurationSeconds?: number;
    // (undocumented)
    startPhase?: Phase;
}

// @public
export enum BenchmarkType {
    Diagnostic = 2,
    Measurement = 1,
    OwnCorrectness = 3,
    Perspective = 0
}

// @public (undocumented)
export interface CustomBenchmark extends BenchmarkTimingOptions {
    benchmarkFnCustom<T>(state: BenchmarkTimer<T>): Promise<void>;
}

// @public (undocumented)
export type CustomBenchmarkArguments = MochaExclusiveOptions & CustomBenchmark & BenchmarkDescription;

// @public
export interface CustomBenchmarkOptions extends Titled, BenchmarkDescription, MochaExclusiveOptions {
    run: (reporter: IMeasurementReporter) => void | Promise<unknown>;
}

// @public
export type CustomData = Record<string, {
    rawValue: unknown;
    formattedValue: string;
}>;

// @public
export function geometricMean(values: number[]): number;

// @public
export interface HookArguments {
    after?: HookFunction | undefined;
    before?: HookFunction | undefined;
}

// @public
export type HookFunction = () => void | Promise<unknown>;

// @public
export interface IMeasurementReporter {
    addMeasurement(key: string, value: number): void;
}

// @public (undocumented)
export interface IMemoryTestObject extends MemoryTestObjectProps {
    after?: HookFunction;
    afterIteration?: HookFunction;
    before?: HookFunction;
    beforeIteration?: HookFunction;
    run(): Promise<unknown>;
}

// @public
export const isInPerformanceTestingMode: boolean;

// @public
export function isResultError(result: BenchmarkResult): result is BenchmarkError;

// @public (undocumented)
export interface MemoryTestObjectProps extends MochaExclusiveOptions, Titled, BenchmarkDescription {
    readonly allowedDeviationBytes?: number;
    readonly baselineMemoryUsage?: number;
    readonly maxBenchmarkDurationSeconds?: number;
    readonly maxRelativeMarginOfError?: number;
    readonly minSampleCount?: number;
    readonly samplePercentageToUse?: number;
}

// @public
export interface MochaExclusiveOptions {
    only?: boolean;
}

// @public
export interface OnBatch {
    beforeEachBatch?: () => void;
}

// @public (undocumented)
export enum Phase {
    // (undocumented)
    AdjustIterationPerBatch = 1,
    // (undocumented)
    CollectData = 2,
    // (undocumented)
    WarmUp = 0
}

// @public
export function prettyNumber(num: number, numDecimals?: number): string;

// @public
export function qualifiedTitle(args: BenchmarkDescription & Titled & {
    testType?: TestType | undefined;
}): string;

// @public
export function runBenchmark(args: BenchmarkRunningOptions): Promise<BenchmarkData>;

// @public
export interface Stats {
    readonly arithmeticMean: number;
    readonly marginOfError: number;
    readonly marginOfErrorPercent: number;
    readonly samples: readonly number[];
    readonly standardDeviation: number;
    readonly standardErrorOfMean: number;
    readonly variance: number;
}

// @public (undocumented)
export enum TestType {
    ExecutionTime = 0,
    MemoryUsage = 1
}

// @public (undocumented)
export interface Timer<T = unknown> {
    // (undocumented)
    now(): T;
    // (undocumented)
    toSeconds(before: T, after: T): number;
}

// @public
export interface Titled {
    title: string;
}

// @public
export function validateBenchmarkArguments(args: BenchmarkSyncArguments | BenchmarkAsyncArguments): {
    isAsync: true;
    benchmarkFn: () => Promise<unknown>;
} | {
    isAsync: false;
    benchmarkFn: () => void;
};

```
