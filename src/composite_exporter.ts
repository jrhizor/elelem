import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';

export class CompositeExporter implements SpanExporter {
    private readonly _spanExporters: SpanExporter[];
    constructor(spanExporters: SpanExporter[] = []) {
        this._spanExporters = spanExporters;
    }

    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
        let completedExporters = 0;
        let failed = false;

        const handleCallback = (result: ExportResult) => {
            completedExporters++;
            if (result.code !== ExportResultCode.SUCCESS) {
                failed = true;
            }
            if (completedExporters === this._spanExporters.length) {
                resultCallback(failed ? { code: ExportResultCode.FAILED } : { code: ExportResultCode.SUCCESS });
            }
        };

        this._spanExporters.forEach(exporter => exporter.export(spans, handleCallback));
    }

    shutdown(): Promise<void> {
        return Promise.all(this._spanExporters.map(exporter => exporter.shutdown())).then(() => {});
    }
}
