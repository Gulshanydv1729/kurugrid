# /paper2agent Command

## Usage

/paper2agent <repository-or-paper>

## Examples

```
/paper2agent https://github.com/example/research-project
/paper2agent ./research-project
/paper2agent paper.pdf ./research-project
/paper2agent <paper-url> <repository-url>
```

## Description

Starts the complete Paper2Agent pipeline from research analysis through to MCP server generation. The command orchestrates all 10 phases:

1. Research analysis - understand the scientific problem
2. Repository analysis - inspect the codebase
3. Runtime analysis - determine installation/runtime requirements
4. Operation selection - choose meaningful operations
5. Reference execution - validate original implementations
6. MCP generation - create thin adapter tools
7. Testing - run comprehensive tests
8. Independent verification - verify tool correctness
9. Repair if necessary - fix any issues
10. Packaging - generate the complete project

## Output

After successful processing, generates:

- generated/<project-name>/ README.md
- generated/<project-name>/mcp/server.py
- generated/<project-name>/mcp/tools/
- generated/<project-name>/tests/
- generated/<project-name>/runtime-report.json
- generated/<project-name>/tool-spec.json
- generated/<project-name>/verification-report.json
- generated/<project-name>/requirements.txt
- generated/<project-name>/pyproject.toml

## Failure Handling

If the pipeline fails at any phase, it reports the failure and stops. The user can then:
- Fix the issue manually
- Run `/paper2agent verify <generated-project>` to diagnose
- Repair and re-run the pipeline