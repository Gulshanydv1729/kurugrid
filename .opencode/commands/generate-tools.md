# /generate-tools Command

## Usage

/generate-tools <repository-or-spec>

## Description

Generates MCP tools from a tool-spec.json or repository inspection. This performs Phases 4-6:

Phase 4: Operation selection from tool-spec or repository analysis
Phase 5: Reference execution of original implementations
Phase 6: MCP tool generation - create thin adapter tools that wrap original code

## Output

Generates MCP tools in `paper2agent/mcp/generated/` with the format:

```typescript
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("research-agent")

@mcp.tool()
def place_limit_order_tool(price: string, size: string) -> dict:
    """
    Place a single limit order on the Kuru CLOB.
    """
    from kuruClient import placeLimit
    return placeLimit(price, size)
```

## Input

Accepts:
- A path to tool-spec.json
- A repository path (inspects and generates tools automatically)