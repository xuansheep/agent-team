export type ToolContext = {
  cwd: string;
  runDir?: string;
  nodeId?: string;
  attempt?: number;
};

export type ToolResult = {
  output?: string;
  error?: string;
  exit_code?: number;
  artifact_id?: string;
  path?: string;
  description?: string;
};

export type Tool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
};
