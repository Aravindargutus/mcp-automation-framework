/**
 * JSON Reporter — writes the MCPProbeReport as a JSON file.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPProbeReport } from './schema.js';

export function writeJsonReport(report: MCPProbeReport, outputDir: string): string {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const filename = `mcp-probe-${report.runId.slice(0, 8)}.json`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  return filePath;
}
