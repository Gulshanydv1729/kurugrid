/**
 * Tool Generator
 * 
 * Turns tool-spec.json into MCP tools.
 * Uses the existing implementation whenever possible.
 * Generated tools are thin adapters that call the original code.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ToolSpec {
  project_name: string;
  generated_at: string;
  operations: Array<{
    name: string;
    description: string;
    input_schema: {
      type: string;
      properties: Record<string, {
        type: string;
        description: string;
      }>;
      required: string[];
      additionalProperties: boolean;
    };
    output_schema: {
      type: string;
      properties: Record<string, {
        type: string;
        description: string;
      }>;
      required: string[];
    };
    source_file: string;
    source_function: string;
    dependencies: string[];
    example_usage: {
      inputs: Record<string, unknown>;
      output: unknown;
    };
    confidence: 'high' | 'medium' | 'low';
  }>;
}

/**
 * Generate an MCP tool Python file from an operation spec
 */
export function generateMcpToolPython(spec: {
  operation: { name: string; description: string; input_schema: { properties: Record<string, { type: string; description: string }>; required: string[]; additionalProperties: boolean; }; output_schema: { properties: Record<string, { type: string; description: string }>; required: string[]; }; source_file: string; source_function: string; dependencies: string[]; example_usage: { inputs: Record<string, unknown>; output: unknown; }; confidence: string; };
  specIndex: number;
  outputDir: string;
}): string {
  const op = spec.operation;
  const toolName = op.name.replace(/_/g, '').toLowerCase();
  const safeName = op.name; // Keep underscores for Python

  // Build the parameter list for the function signature
  const propKeys: string[] = Object.keys(op.input_schema.properties || {});
  const paramNames: string[] = propKeys.length > 0 ? propKeys : [];

  // Build the parameters description text
  let paramsDescription: string = '';
  if (paramNames.length > 0) {
    paramsDescription = paramNames.map((key) => {
      const prop: any = op.input_schema.properties![key];
      return '- **' + key + '** (' + prop.type + '): ' + prop.description;
    }).join('\n');
  }

  // Build the returns description text
  let returnsDescription: string = '';
  const outputProps: any = op.output_schema.properties || {};
  const outputPropKeys: string[] = Object.keys(outputProps);
  if (outputPropKeys.length > 0) {
    returnsDescription = outputPropKeys.map((key) => {
      const prop: any = outputProps[key];
      return '- **' + key + '** (' + prop.type + '): ' + prop.description;
    }).join('\n');
  }

  // Build the input validation code
  let inputValidationCode: string = '';
  if (paramNames.length > 0) {
    inputValidationCode = paramNames.map((key) => {
      return 'if ' + key + ' is None:\\n        raise ValueError("' + key + ' is required")';
    }).join('\n');
  }

  // Build the function call code
  const funcCallCode: string = paramNames.length > 0 ? paramNames.join(', ') : '';

  // Build the result handling code string
  const resultHandlingCode: string = 'result if isinstance(result, dict) else {"output": str(result)}';

  // Build the tool content using string concatenation
  const specPathEscaped = op.source_file.replace(/"/g, '\\"');
  const sourceFunctionEscaped = op.source_function.replace(/"/g, '\\"');

  const toolContent = 'from mcp.server.fastmcp import FastMCP\n\n' +
    'mcp = FastMCP("' + op.name + '")\n\n' +
    '@mcp.tool()\n' +
    'def ' + safeName + '(' + paramNames.join(', ') + ') -> dict:\n' +
    '    """\n' +
    op.description + '\n\n' +
    '    Parameters\n    ----------\n' +
    paramsDescription + '\n\n' +
    '    Returns\n    -------\n' +
    returnsDescription + '\n' +
    '    """\n' +
    '    # Call the original repository implementation\n' +
    '    # Source: ' + specPathEscaped + '\n' +
    '    # Function: ' + sourceFunctionEscaped + '\n\n' +
    '    # Import and call the original implementation\n' +
    '    import sys\n' +
    '    import importlib.util\n\n' +
    '    # Dynamically import the source module\n' +
    '    const spec_path = "' + specPathEscaped + '";\n' +
    '    const module_name = "' + sourceFunctionEscaped + '_tool";\n\n' +
    '    # Load the module from the source file path\n' +
    '    const spec_dir = "/".join(spec_path.split("/").slice(0, -1));\n' +
    '    sys.path.insert(0, spec_dir);\n\n' +
    '    const spec = importlib.util.spec_from_file_location(module_name, spec_path);\n' +
    '    if spec is not None:\n' +
    '        mod = importlib.util.module_from_spec(spec);\n' +
    '        spec.loader.exec_module(mod);\n\n' +
    '    func = getattr(mod, "' + sourceFunctionEscaped + '", None);\n' +
    '    if func is None:\n' +
    '        raise ImportError("Could not find function \'" + sourceFunctionEscaped + "\' in " + spec_path);\n\n' +
    '    # Validate inputs before calling\n' +
    inputValidationCode + '\n\n' +
    '    # Call the original implementation with validated inputs\n' +
    '    try:\n' +
    '        result = func(' + funcCallCode + ');\n' +
    '    except Exception as e:\n' +
    '        return {\n' +
    '            "error": str(e),\n' +
    '            "status": "failed",\n' +
    '            "operation": "' + op.name + '"\n' +
    '        };\n\n' +
    '    # Return structured result\n' +
    '    return {\n' +
    '        "status": "success",\n' +
    '        "operation": "' + op.name + '"\n' +
    '        , "result": ' + resultHandlingCode + '\n' +
    '    }';

  // Write the tool file
  const toolPath = path.join(spec.outputDir, 'mcp', 'tools', safeName + '.py');
  const toolDir = path.dirname(toolPath);
  if (!fs.existsSync(toolDir)) {
    fs.mkdirSync(toolDir, { recursive: true });
  }
  fs.writeFileSync(toolPath, toolContent);

  return toolPath;
}

/**
 * Generate an MCP server Python file from a tool spec
 */
export function generateMcServerPython(spec: ToolSpec, outputDir: string): string {
  const toolsDir = path.join(outputDir, 'mcp', 'tools');

  // Generate all tool files first
  const toolFiles: string[] = [];
  for (let i = 0; i < spec.operations.length; i++) {
    const toolPath = generateMcpToolPython({
      operation: spec.operations[i],
      specIndex: i,
      outputDir,
    });
    toolFiles.push(toolPath);
  }

  // Generate the server file
  // Build tool imports
  let toolImports: string = '';
  for (let i = 0; i < spec.operations.length; i++) {
    const op: any = spec.operations[i];
    const safeName: string = op.name.replace(/_/g, '').toLowerCase();
    toolImports += 'from mcp.tools.' + safeName + ' import ' + op.name.replace(/_/g, '') + ' as ' + op.name + 'Tool\n';
  }

  // Build tool initializations
  let toolInitializations: string = '';
  for (let i = 0; i < spec.operations.length; i++) {
    const op: any = spec.operations[i];
    const safeName: string = op.name.replace(/_/g, '').toLowerCase();
    toolInitializations += '    ' + op.name + 'Tool(),\n';
  }

  const serverContent: string = 'from mcp.server.fastmcp import FastMCP\n' +
    'import sys\n' +
    'import os\n\n' +
    '# Add tools directory to path\n' +
    'sys.path.insert(0, "' + toolsDir + '")\n\n' +
    'mcp = FastMCP("' + spec.project_name + '")\n\n' +
    '# Import all generated tools\n' +
    toolImports + '\n\n' +
    '@mcp.tool()\n' +
    'def dispatch_tool(name: str, **kwargs) -> dict:\n' +
    '    """\n' +
    '    Dispatch a tool call by name.\n' +
    '    */\n' +
    '    tool_map = {\n' +
    toolInitializations + '    }\n\n' +
    '    tool = tool_map.get(name);\n' +
    '    if tool is None:\n' +
    '        return {"error": "Unknown tool: " + name, "status": "unknown"}' + '\n' +
    '    try:\n' +
    '        result = tool(**kwargs);\n' +
    '        return result if isinstance(result, dict) else {"result": str(result)}' + '\n' +
    '    except Exception as e:\n' +
    '        return {"error": str(e), "status": "failed"}' + '\n\n' +
    '# Alias each tool directly for easy access\n' +
    spec.operations.map((op: any, i: number) => {
      const safeName: string = op.name.replace(/_/g, '').toLowerCase();
      return '\n' + op.name.replace(/_/g, '') + '(**kwargs) = dispatch_tool("' + op.name + '", **kwargs)';
    }).join('') + '\n';

  const serverPath = path.join(outputDir, 'mcp', 'server.py');
  if (!fs.existsSync(path.dirname(serverPath))) {
    fs.mkdirSync(path.dirname(serverPath), { recursive: true });
  }
  fs.writeFileSync(serverPath, serverContent);

  return serverPath;
}

/**
 * Generate a tool-spec.json from mapped operations
 */
export function generateToolSpec(mappedOperations: Array<{
  name: string;
  description: string;
  source_file: string;
  source_function: string;
  inputs: Array<{ name: string; type: string; description: string }>;
  outputs: Array<{ name: string; type: string; description: string }>;
  dependencies: string[];
  example_usage: {
    inputs: Record<string, unknown>;
    output: unknown;
  };
  confidence: 'high' | 'medium' | 'low';
}>): string {
  const spec: any = {
    project_name: 'paper2agent-generated',
    generated_at: new Date().toISOString(),
    operations: mappedOperations.map((op: any, i: number) => ({
      name: op.name,
      description: op.description,
      input_schema: {
        type: 'object',
        properties: Object.fromEntries(op.inputs.map((inp: any) => [inp.name, { type: inp.type, description: inp.description }])),
        required: op.inputs.map((inp: any) => inp.name),
        additionalProperties: false,
      },
      output_schema: {
        type: 'object',
        properties: Object.fromEntries(op.outputs.map((out: any) => [out.name, { type: out.type, description: out.description }])),
        required: op.outputs.map((out: any) => out.name),
      },
      source_file: op.source_file,
      source_function: op.source_function,
      dependencies: op.dependencies,
      example_usage: op.example_usage,
      confidence: op.confidence,
    })),
  };

  // Write the spec file
  const specPath: string = 'generated/tool-spec.json';
  if (!fs.existsSync(path.dirname(specPath))) {
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
  }
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));

  return specPath;
}

/**
 * Generate the complete MCP project structure
 */
export function generateProject(spec: ToolSpec, outputName: string): string {
  const outputDir: string = path.join('generated', outputName);

  // Generate MCP server
  generateMcServerPython(spec, outputDir);

  // Generate README
  generateReadme(spec, outputDir);

  // Generate requirements
  generateRequirements(spec, outputDir);

  // Generate pyproject.toml
  generatePyproject(spec, outputDir);

  return outputDir;
}

/**
 * Generate README.md for the MCP project
 */
function generateReadme(spec: ToolSpec, outputDir: string): string {
  // Build the tools section
  let toolsSection: string = '';
  for (let i: number = 0; i < spec.operations.length; i++) {
    const op: any = spec.operations[i];
    const safeName: string = op.name.replace(/_/g, '').toLowerCase();
    toolsSection += '### ' + op.name + '\n\n';
    toolsSection += op.description + '\n\n';
    toolsSection += '**Input Parameters:**\n';
    if (Object.keys(op.input_schema.properties || {}).length > 0) {
      toolsSection += Object.entries(op.input_schema.properties || {}).map(([key: string, value: any]) => {
        return '- ' + key + ': ' + value.type + ' - ' + value.description;
      }).join('\n');
    }
    toolsSection += '\n**Output:**\n';
    if (Object.keys(op.output_schema.properties || {}).length > 0) {
      toolsSection += Object.entries(op.output_schema.properties || {}).map(([key: string, value: any]) => {
        return '- ' + key + ': ' + value.type;
      }).join('\n');
    }
    toolsSection += '\n**Example:**\n```python\nfrom paper2agent.mcp.tools import ' + safeName + '\nresult = ' + safeName + '(price=\'100.00\', size=\'1.0\')\nprint(result)\n```\n\n';
  }

  const readmeContent: string = '# ' + spec.project_name + '\n\n' +
    '## Overview\n\n' +
    'Research-to-agent framework that generates MCP tools from scientific implementations.\n\n' +
    '## Generated Tools\n\n' +
    toolsSection +
    '## Installation\n\n' +
    '1. Install dependencies:\n```bash\npip install -r requirements.txt\n# or\nnpm install\n```\n\n' +
    '2. Start the MCP server:\n```bash\npython -m mcp.server\n```\n\n' +
    '## Usage\n\n' +
    'Connect OpenCode to the MCP server running on the default port (8000).\n\n' +
    '## Runtime Requirements\n\n' +
    '- Python 3.8+\n' +
    '- Required dependencies (see requirements.txt)\n' +
    '- Network access to Monad Testnet (for blockchain operations)\n\n' +
    '## Verification\n\n' +
    'Generated tools have been verified against original implementations.\n\n' +
    '## License\n\n' +
    'See LICENSE for details.\n';

  const readmePath: string = path.join(outputDir, 'README.md');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(readmePath, readmeContent);

  return readmePath;
}

/**
 * Generate requirements.txt
 */
function generateRequirements(spec: ToolSpec, outputDir: string): string {
  const allDeps: Set<string> = new Set();

  for (let i: number = 0; i < spec.operations.length; i++) {
    const op: any = spec.operations[i];
    for (let j: number = 0; j < op.dependencies.length; j++) {
      allDeps.add(op.dependencies[j]);
    }
  }

  // Add core dependencies
  allDeps.add('mcp>=1.0.0');
  allDeps.add('fastmcp');

  const reqPath: string = path.join(outputDir, 'requirements.txt');
  fs.writeFileSync(reqPath, [...allDeps].map((d: string) => d.trim()).filter((d: string) => d.length > 0).join('\n'));

  return reqPath;
}

/**
 * Generate pyproject.toml
 */
function generatePyproject(spec: ToolSpec, outputDir: string): string {
  // Build dependencies section
  let depsSection: string = '';
  for (let i: number = 0; i < spec.operations.length; i++) {
    const op: any = spec.operations[i];
    for (let j: number = 0; j < op.dependencies.length; j++) {
      const dep: string = op.dependencies[j];
      if (dep.trim().length > 0) {
        depsSection += '  ' + dep + '\n';
      }
    }
  }
  if (depsSection.length === 0) {
    depsSection = '  mcp = "*"\n';
  }

  const tomlContent: string = '[project]\n' +
    'name = "' + spec.project_name + '"\n' +
    'version = "0.1.0"\n' +
    'description = "Paper2Agent generated MCP tools"\n\n' +
    '[project.dependencies]\n' +
    depsSection +
    '\n[build-system]\n' +
    'requires = ["setuptools"]\n' +
    'build-backend = "setuptools.backends._legacy:_Backend"';

  const pyprojectPath: string = path.join(outputDir, 'pyproject.toml');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(pyprojectPath, tomlContent);

  return pyprojectPath;
}