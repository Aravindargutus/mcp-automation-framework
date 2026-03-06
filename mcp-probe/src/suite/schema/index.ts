/**
 * Schema Suite — validates tool/resource/prompt schemas and tests inputs.
 *
 * Tests:
 * - Each tool's inputSchema is valid JSON Schema
 * - Valid inputs are accepted
 * - Invalid inputs produce errors (not crashes)
 * - Schema drift detection
 * - Documentation quality (descriptions present)
 */
import type { TestSuite, TestCase, TestRunContext, TestCaseResult } from '../types.js';
import { AssertHelper } from '../types.js';
import type { DiscoveredServer, DiscoveredTool } from '../../client/mcp-client.js';
import type { ServerConfig } from '../../config/schema.js';
import { isValidJsonSchema, validateAgainstSchema } from './validator.js';
import { generateFuzzedInputs } from './fuzzer.js';
import { classifyToolSafety, isSafeToFuzz } from './tool-safety.js';

export class SchemaSuite implements TestSuite {
  name = 'schema';
  description = 'Schema validation, input fuzzing, and documentation quality checks';
  tags = ['schema'];

  isApplicable(discovered: DiscoveredServer): boolean {
    return discovered.tools.length > 0 || discovered.resources.length > 0 || discovered.prompts.length > 0;
  }

  generateTests(discovered: DiscoveredServer, serverConfig: ServerConfig): TestCase[] {
    const tests: TestCase[] = [];

    // --- Per-tool tests ---
    for (const tool of discovered.tools) {
      // Schema validity
      tests.push(this.createSchemaValidityTest(tool));

      // Documentation
      tests.push(this.createDocumentationTest(tool));

      // Input fuzzing (for safe-to-fuzz tools)
      if (isSafeToFuzz(tool, serverConfig.toolSafety)) {
        tests.push(...this.createFuzzTests(tool));
      }

      // Safety classification info
      tests.push(this.createSafetyClassificationTest(tool, serverConfig));
    }

    // --- Per-resource tests ---
    for (const resource of discovered.resources) {
      tests.push({
        id: `schema.resource.${resource.uri}.has-uri`,
        name: `Resource "${resource.name}" has valid URI`,
        description: 'Resources must have a non-empty URI',
        tags: ['schema', 'resource'],
        async run(_ctx: TestRunContext): Promise<TestCaseResult> {
          const assert = new AssertHelper();
          assert.ok(typeof resource.uri === 'string' && resource.uri.length > 0, 'URI is non-empty');
          assert.warn(
            resource.description !== undefined && resource.description.length > 0,
            'has-description',
            'Resource has a description',
          );
          return { assertions: assert.assertions };
        },
      });
    }

    // --- Per-prompt tests ---
    for (const prompt of discovered.prompts) {
      tests.push({
        id: `schema.prompt.${prompt.name}.valid`,
        name: `Prompt "${prompt.name}" has valid structure`,
        description: 'Prompts must have a name and argument definitions',
        tags: ['schema', 'prompt'],
        async run(_ctx: TestRunContext): Promise<TestCaseResult> {
          const assert = new AssertHelper();
          assert.ok(typeof prompt.name === 'string' && prompt.name.length > 0, 'Name is non-empty');
          assert.warn(
            prompt.description !== undefined && prompt.description.length > 0,
            'has-description',
            'Prompt has a description',
          );
          if (prompt.arguments) {
            for (const arg of prompt.arguments) {
              assert.ok(
                typeof arg.name === 'string' && arg.name.length > 0,
                `Argument "${arg.name}" has a name`,
              );
            }
          }
          return { assertions: assert.assertions };
        },
      });
    }

    return tests;
  }

  private createSchemaValidityTest(tool: DiscoveredTool): TestCase {
    return {
      id: `schema.tool.${tool.name}.input-schema-valid`,
      name: `Tool "${tool.name}" has valid inputSchema`,
      description: 'inputSchema must be valid JSON Schema',
      tags: ['schema', 'tool', 'required'],
      async run(_ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        assert.ok(
          tool.inputSchema !== undefined && tool.inputSchema !== null,
          'inputSchema is present',
        );

        if (tool.inputSchema) {
          assert.ok(
            isValidJsonSchema(tool.inputSchema),
            'inputSchema is valid JSON Schema',
          );

          assert.ok(
            tool.inputSchema.type === 'object',
            'inputSchema root type is "object"',
          );
        }

        return { assertions: assert.assertions };
      },
    };
  }

  private createDocumentationTest(tool: DiscoveredTool): TestCase {
    return {
      id: `schema.tool.${tool.name}.documentation`,
      name: `Tool "${tool.name}" has documentation`,
      description: 'Tools should have descriptions for LLM usage',
      tags: ['schema', 'tool', 'documentation'],
      async run(_ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        assert.warn(
          tool.description !== undefined && tool.description.length > 0,
          'has-description',
          'Tool has a description',
        );

        assert.warn(
          tool.description !== undefined && tool.description.length >= 20,
          'description-quality',
          `Description is detailed enough (${tool.description?.length ?? 0} chars, recommend 20+)`,
        );

        // Check property descriptions in inputSchema
        const properties = (tool.inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
        const propKeys = Object.keys(properties);
        const withDesc = propKeys.filter((k) => properties[k].description);
        if (propKeys.length > 0) {
          assert.warn(
            withDesc.length === propKeys.length,
            'property-descriptions',
            `${withDesc.length}/${propKeys.length} properties have descriptions`,
          );
        }

        return { assertions: assert.assertions };
      },
    };
  }

  private createFuzzTests(tool: DiscoveredTool): TestCase[] {
    const fuzzedInputs = generateFuzzedInputs(tool.inputSchema);

    return fuzzedInputs.map((input) => ({
      id: `schema.tool.${tool.name}.fuzz.${input.category}.${input.label.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50)}`,
      name: `Tool "${tool.name}" fuzz: ${input.label}`,
      description: `Fuzz test with ${input.category} input`,
      tags: ['schema', 'tool', 'fuzz', input.category],
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        // First validate against schema
        if (tool.inputSchema && input.data !== null && typeof input.data === 'object') {
          const validation = validateAgainstSchema(input.data, tool.inputSchema);
          if (input.expectValid) {
            assert.ok(validation.valid, 'Input validates against schema');
          }
        }

        // For valid inputs on safe tools, actually call the tool
        if (input.expectValid && input.category === 'valid') {
          try {
            const trace = await ctx.client.callTool(tool.name, input.data);
            assert.ok(!trace.isError, 'Tool call did not error');
            assert.info('response-time', `Response in ${trace.durationMs}ms`);
          } catch (err) {
            assert.ok(false, 'Tool call completed', (err as Error).message);
          }
        }

        // For invalid inputs, call and verify graceful error (not crash)
        if (!input.expectValid && input.category === 'missing_required') {
          try {
            const trace = await ctx.client.callTool(tool.name, input.data);
            // We expect an error response, not a crash
            assert.ok(
              trace.isError || trace.response !== undefined,
              'Server handled invalid input gracefully (did not crash)',
            );
          } catch (err) {
            // Transport error = crash = bad
            assert.ok(false, 'Server crashed on invalid input', (err as Error).message);
          }
        }

        return { assertions: assert.assertions };
      },
    }));
  }

  private createSafetyClassificationTest(tool: DiscoveredTool, serverConfig: ServerConfig): TestCase {
    return {
      id: `schema.tool.${tool.name}.safety-class`,
      name: `Tool "${tool.name}" safety classification`,
      description: 'Reports the tool safety classification (read/write)',
      tags: ['schema', 'tool', 'safety'],
      async run(_ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const safety = classifyToolSafety(tool, serverConfig.toolSafety);
        assert.info('safety-class', `Classified as: ${safety}`);

        if (tool.annotations) {
          assert.info(
            'annotations',
            `Annotations: readOnly=${tool.annotations.readOnlyHint}, destructive=${tool.annotations.destructiveHint}`,
          );
        }

        return { assertions: assert.assertions, metadata: { safetyClass: safety } };
      },
    };
  }
}
