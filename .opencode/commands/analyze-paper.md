# /analyze-paper Command

## Usage

/analyze-paper <paper-or-repository>

## Description

Starts the analysis pipeline (Phases 1-4 of the Paper2Agent workflow):

Phase 1: Research analysis - understand the scientific problem from a paper
Phase 2: Repository analysis - inspect the codebase structure
Phase 3: Runtime analysis - determine installation/runtime requirements
Phase 4: Operation selection - choose meaningful operations for MCP tool generation

## Output

Produces:
- research report (research_problem, algorithms, workflows, etc.)
- tool-spec.json with selected operations
- runtime-report.json with runtime requirements
- Catalog of candidate operations with source mappings

## Use Case

When you have a research paper and want to understand what MCP tools can be generated from the associated code, without running the full pipeline.