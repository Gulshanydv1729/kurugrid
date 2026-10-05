# /package-agent Command

## Usage

/package-agent <generated-project>

## Description

Packages a generated project for distribution. This performs Phase 10:

- Generates the complete project structure under generated/<project-name>/
- Creates README.md with tool descriptions and usage examples
- Creates mcp/server.py with all generated tools loaded
- Creates mcp/tools/ with individual tool modules
- Creates tests/ with test suite
- Creates runtime-report.json
- Creates tool-spec.json
- Creates verification-report.json
- Creates requirements.txt with all dependencies
- Creates pyproject.toml for package configuration

## Output Structure

```
generated/<project-name>/
├── README.md
├── mcp/
│   ├── server.py
│   └── tools/
│       ├── __init__.py
│       ├── place_limit_order.py
│       └── ...
├── tests/
│   ├── test_place_limit_order.py
│   └── ...
├── runtime-report.json
├── tool-spec.json
├── verification-report.json
├── requirements.txt
└── pyproject.toml
```