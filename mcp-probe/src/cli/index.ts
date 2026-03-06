#!/usr/bin/env node
/**
 * MCP Probe CLI — the user-facing entry point.
 *
 * Commands:
 *   test <config>           Run tests against MCP servers
 *   inspect <config>        Discover and list server capabilities
 *   validate-config <file>  Validate a config file without running tests
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, ConfigLoadError } from '../config/loader.js';
import { run } from '../runner/runner.js';
import { writeJsonReport } from '../reporter/json.js';
import { writeHtmlReport } from '../reporter/html.js';
import type { MCPProbeReport } from '../reporter/schema.js';

const program = new Command();

program
  .name('mcp-probe')
  .description('Comprehensive validation and automation framework for MCP servers')
  .version('0.1.0');

// --- test command ---
program
  .command('test')
  .description('Run validation tests against MCP servers')
  .argument('<config>', 'Path to config file (YAML or JSON)')
  .option('--verbose', 'Show detailed JSON-RPC traces', false)
  .option('--filter <pattern>', 'Run only tests matching this pattern')
  .option('--format <format>', 'Output format: json, html, both', 'json')
  .option('--output-dir <dir>', 'Output directory for reports')
  .option('--max-concurrent <n>', 'Max parallel servers', parseInt)
  .action(async (configPath: string, opts: Record<string, unknown>) => {
    try {
      const config = loadConfig(configPath);

      // Apply CLI overrides
      if (opts.maxConcurrent) {
        config.defaults = {
          maxConcurrent: opts.maxConcurrent as number,
          maxOutputBytes: config.defaults?.maxOutputBytes ?? 1_048_576,
          allowWriteFuzzing: config.defaults?.allowWriteFuzzing ?? false,
          timeout: config.defaults?.timeout,
        };
      }

      const outputDir = (opts.outputDir as string) ?? config.output?.dir ?? './mcp-probe-results';
      const format = (opts.format as string) ?? config.output?.format ?? 'json';

      console.log(chalk.blue('\n  MCP Probe v0.1.0\n'));
      console.log(chalk.dim(`  Servers: ${config.servers.length}`));
      console.log(chalk.dim(`  Suites:  ${(config.suites?.include ?? ['protocol', 'schema']).join(', ')}`));
      console.log();

      const report = await run({
        config,
        onServerStart(name) {
          console.log(chalk.dim(`  Testing ${name}...`));
        },
        onServerEnd(name, serverReport) {
          if (!serverReport.connected) {
            console.log(chalk.red(`  ${name}: Connection failed — ${serverReport.connectionError}`));
            return;
          }
          const score = serverReport.score;
          if (score) {
            const gradeColor = score.grade === 'A' ? chalk.green
              : score.grade === 'B' ? chalk.yellow
              : chalk.red;
            console.log(`  ${name}: ${gradeColor(score.grade)} (${score.percentage}%) — ${score.passed}/${score.total} passed`);
          } else {
            console.log(`  ${name}: No tests ran`);
          }
        },
      });

      // Write reports
      const paths: string[] = [];
      if (format === 'json' || format === 'both') {
        paths.push(writeJsonReport(report, outputDir));
      }
      if (format === 'html' || format === 'both') {
        paths.push(writeHtmlReport(report, outputDir));
      }

      // Summary
      printSummary(report);

      for (const p of paths) {
        console.log(chalk.dim(`  Report: ${p}`));
      }
      console.log();

      // Exit with non-zero if any server failed
      const anyFailed = report.servers.some((s) =>
        !s.connected || (s.score && s.score.grade === 'F'),
      );
      process.exit(anyFailed ? 1 : 0);

    } catch (err) {
      if (err instanceof ConfigLoadError) {
        console.error(chalk.red(`\n  Config error: ${err.message}\n`));
        process.exit(2);
      }
      console.error(chalk.red(`\n  Error: ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// --- inspect command ---
program
  .command('inspect')
  .description('Discover and display server capabilities')
  .argument('<config>', 'Path to config file')
  .option('--server <name>', 'Inspect only this server')
  .option('--tool <name>', 'Show details for a specific tool')
  .action(async (configPath: string, opts: Record<string, unknown>) => {
    try {
      const config = loadConfig(configPath);
      const { MCPProbeClient } = await import('../client/mcp-client.js');
      const { StdioTransport } = await import('../transport/stdio.js');
      const { HttpTransport } = await import('../transport/http.js');

      for (const serverConfig of config.servers) {
        if (opts.server && serverConfig.name !== opts.server) continue;

        console.log(chalk.blue(`\n  Server: ${serverConfig.name}`));

        let transport;
        if (serverConfig.transport.type === 'stdio') {
          transport = new StdioTransport({
            command: serverConfig.transport.command,
            args: serverConfig.transport.args,
            cwd: serverConfig.transport.cwd,
            env: serverConfig.transport.env,
          });
        } else {
          transport = new HttpTransport({
            url: serverConfig.transport.url,
            headers: serverConfig.transport.headers,
          });
        }

        const client = new MCPProbeClient(transport, serverConfig);

        try {
          const discovered = await client.connect();

          console.log(chalk.dim(`  ${discovered.serverInfo.name} v${discovered.serverInfo.version}`));
          console.log(chalk.dim(`  Protocol: ${discovered.protocolVersion}`));
          console.log();

          // Tools
          if (discovered.tools.length > 0) {
            console.log(chalk.yellow(`  Tools (${discovered.tools.length}):`));
            for (const tool of discovered.tools) {
              if (opts.tool && tool.name !== opts.tool) continue;
              console.log(`    ${chalk.white(tool.name)}`);
              if (tool.description) {
                console.log(chalk.dim(`      ${tool.description}`));
              }
              if (opts.tool) {
                console.log(chalk.dim(`      Schema: ${JSON.stringify(tool.inputSchema, null, 2).replace(/\n/g, '\n      ')}`));
              }
            }
          }

          // Resources
          if (discovered.resources.length > 0) {
            console.log(chalk.yellow(`\n  Resources (${discovered.resources.length}):`));
            for (const res of discovered.resources) {
              console.log(`    ${chalk.white(res.uri)} (${res.mimeType ?? 'unknown'})`);
            }
          }

          // Prompts
          if (discovered.prompts.length > 0) {
            console.log(chalk.yellow(`\n  Prompts (${discovered.prompts.length}):`));
            for (const prompt of discovered.prompts) {
              console.log(`    ${chalk.white(prompt.name)}`);
              if (prompt.description) {
                console.log(chalk.dim(`      ${prompt.description}`));
              }
            }
          }

          await client.disconnect();
        } catch (err) {
          console.error(chalk.red(`  Connection failed: ${(err as Error).message}`));
        }
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`\n  Error: ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

// --- validate-config command ---
program
  .command('validate-config')
  .description('Validate a config file without running tests')
  .argument('<file>', 'Path to config file')
  .action((filePath: string) => {
    try {
      const config = loadConfig(filePath);
      console.log(chalk.green('\n  Config is valid!\n'));
      console.log(chalk.dim(`  Servers: ${config.servers.length}`));
      for (const s of config.servers) {
        console.log(chalk.dim(`    - ${s.name} (${s.transport.type})`));
      }
      console.log();
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        console.error(chalk.red(`\n  Invalid config:\n  ${err.message}\n`));
        process.exit(2);
      }
      console.error(chalk.red(`\n  Error: ${(err as Error).message}\n`));
      process.exit(1);
    }
  });

function printSummary(report: MCPProbeReport): void {
  console.log(chalk.blue('\n  Summary'));
  console.log(chalk.dim(`  Duration: ${report.duration}ms`));

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  for (const server of report.servers) {
    for (const suite of server.suites) {
      totalPassed += suite.passed;
      totalFailed += suite.failed;
      totalSkipped += suite.skipped;
    }
  }

  console.log(`  ${chalk.green(`${totalPassed} passed`)}, ${chalk.red(`${totalFailed} failed`)}, ${chalk.dim(`${totalSkipped} skipped`)}`);
}

program.parse();
