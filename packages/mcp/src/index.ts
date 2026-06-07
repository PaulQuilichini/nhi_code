/**
 * MCP client integration — stub for Phase 3.
 * Will connect to stdio and HTTP MCP servers configured in .nhicode/config.toml
 */

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export class McpClient {
  constructor(private servers: McpServerConfig[] = []) {}

  listServers(): McpServerConfig[] {
    return this.servers;
  }

  // Phase 3: implement connect, listTools, callTool
}

export function createMcpClient(servers: McpServerConfig[] = []): McpClient {
  return new McpClient(servers);
}
