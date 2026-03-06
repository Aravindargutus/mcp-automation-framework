/**
 * Protocol Suite: Lifecycle Tests
 *
 * Tests the MCP initialization handshake:
 * - initialize request → response validation
 * - notifications/initialized is mandatory
 * - Version negotiation
 * - Capability structure
 * - Server info completeness
 * - Shutdown sequence
 */
import type { TestCase, TestRunContext, TestCaseResult } from '../types.js';
import { AssertHelper } from '../types.js';

export function generateLifecycleTests(): TestCase[] {
  return [
    {
      id: 'protocol.lifecycle.initialize-response',
      name: 'Initialize response has required fields',
      description: 'Server must respond to initialize with protocolVersion, capabilities, and serverInfo',
      tags: ['protocol', 'lifecycle', 'required'],
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const { discovered } = ctx;

        // protocolVersion must be present and a string
        assert.ok(
          typeof discovered.protocolVersion === 'string' && discovered.protocolVersion.length > 0,
          'protocolVersion is a non-empty string',
        );

        // serverInfo must have name and version
        assert.hasProperty(discovered.serverInfo, 'name', 'serverInfo has name');
        assert.hasProperty(discovered.serverInfo, 'version', 'serverInfo has version');
        assert.ok(
          typeof discovered.serverInfo.name === 'string' && discovered.serverInfo.name.length > 0,
          'serverInfo.name is non-empty',
        );
        assert.ok(
          typeof discovered.serverInfo.version === 'string' && discovered.serverInfo.version.length > 0,
          'serverInfo.version is non-empty',
        );

        // capabilities must be an object
        assert.ok(
          typeof discovered.capabilities === 'object' && discovered.capabilities !== null,
          'capabilities is an object',
        );

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.lifecycle.version-negotiation',
      name: 'Protocol version is recognized',
      description: 'Server should negotiate a known protocol version',
      tags: ['protocol', 'lifecycle'],
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const knownVersions = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

        assert.ok(
          knownVersions.includes(ctx.discovered.protocolVersion),
          'Protocol version is a known MCP version',
          `Got ${ctx.discovered.protocolVersion}, known: ${knownVersions.join(', ')}`,
        );

        // Record which version for downstream test gating
        assert.info('negotiated-version', `Server negotiated version: ${ctx.discovered.protocolVersion}`);

        return { assertions: assert.assertions, metadata: { negotiatedVersion: ctx.discovered.protocolVersion } };
      },
    },

    {
      id: 'protocol.lifecycle.capabilities-structure',
      name: 'Capabilities have valid structure',
      description: 'Declared capabilities must follow the spec structure',
      tags: ['protocol', 'lifecycle'],
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();
        const caps = ctx.discovered.capabilities;

        // If tools capability is declared, it should be an object
        if ('tools' in caps) {
          assert.ok(typeof caps.tools === 'object', 'tools capability is an object');
        }

        // If resources capability is declared
        if ('resources' in caps) {
          assert.ok(typeof caps.resources === 'object', 'resources capability is an object');
        }

        // If prompts capability is declared
        if ('prompts' in caps) {
          assert.ok(typeof caps.prompts === 'object', 'prompts capability is an object');
        }

        // At least one capability should be declared
        const hasCaps = 'tools' in caps || 'resources' in caps || 'prompts' in caps;
        assert.warn(hasCaps, 'has-at-least-one-capability', 'Server declares at least one primitive (tools/resources/prompts)');

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.lifecycle.ping-pong',
      name: 'Server responds to ping',
      description: 'Server must respond to ping with an empty result (pong)',
      tags: ['protocol', 'lifecycle', 'required'],
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        const response = await ctx.client.ping();

        assert.ok(!response.error, 'Ping did not error', response.error?.message);

        if (response.message) {
          const msg = response.message as Record<string, unknown>;
          assert.hasProperty(msg, 'result', 'Ping response has result field');
        }

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.lifecycle.tools-list-discoverable',
      name: 'Tools are discoverable via tools/list',
      description: 'If tools capability is declared, tools/list must return an array',
      tags: ['protocol', 'lifecycle'],
      requiredCapability: 'tools',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        assert.ok(Array.isArray(ctx.discovered.tools), 'tools/list returns an array');
        assert.info('tool-count', `Discovered ${ctx.discovered.tools.length} tools`);

        // Each tool must have a name
        for (const tool of ctx.discovered.tools) {
          assert.ok(
            typeof tool.name === 'string' && tool.name.length > 0,
            `Tool "${tool.name ?? '(unnamed)'}" has a name`,
          );
        }

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.lifecycle.resources-list-discoverable',
      name: 'Resources are discoverable via resources/list',
      description: 'If resources capability is declared, resources/list must return an array',
      tags: ['protocol', 'lifecycle'],
      requiredCapability: 'resources',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        assert.ok(Array.isArray(ctx.discovered.resources), 'resources/list returns an array');
        assert.info('resource-count', `Discovered ${ctx.discovered.resources.length} resources`);

        for (const resource of ctx.discovered.resources) {
          assert.ok(
            typeof resource.uri === 'string' && resource.uri.length > 0,
            `Resource "${resource.name ?? resource.uri}" has a URI`,
          );
        }

        return { assertions: assert.assertions };
      },
    },

    {
      id: 'protocol.lifecycle.prompts-list-discoverable',
      name: 'Prompts are discoverable via prompts/list',
      description: 'If prompts capability is declared, prompts/list must return an array',
      tags: ['protocol', 'lifecycle'],
      requiredCapability: 'prompts',
      async run(ctx: TestRunContext): Promise<TestCaseResult> {
        const assert = new AssertHelper();

        assert.ok(Array.isArray(ctx.discovered.prompts), 'prompts/list returns an array');
        assert.info('prompt-count', `Discovered ${ctx.discovered.prompts.length} prompts`);

        for (const prompt of ctx.discovered.prompts) {
          assert.ok(
            typeof prompt.name === 'string' && prompt.name.length > 0,
            `Prompt "${prompt.name ?? '(unnamed)'}" has a name`,
          );
        }

        return { assertions: assert.assertions };
      },
    },
  ];
}
