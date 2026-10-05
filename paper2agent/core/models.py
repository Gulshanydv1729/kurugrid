"""
Core data models for the Paper2Agent framework.
Defines the structured types used throughout the pipeline.
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional
from enum import Enum


class Language(Enum):
    PYTHON = "python"
    NODE = "node"
    MIXED = "mixed"


class ToolConfidence(Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


@dataclass
class InputParameter:
    name: str
    type: str
    description: str


@dataclass
class OutputParameter:
    name: str
    type: str
    description: str


@dataclass
class ToolSpec:
    project_name: str
    generated_at: str
    operations: List[dict] = field(default_factory=list)


@dataclass
class RuntimeReport:
    language: Language
    python_version?: str
    node_version?: str
    dependencies: List[dict] = field(default_factory=list)
    gpu_required: bool = False
    environment_variables: List[dict] = field(default_factory=list)
    entrypoints: List[dict] = field(default_factory=list)
    system_dependencies: List[str] = field(default_factory=list)
    model_files: List[str] = field(default_factory=list)
    datasets: List[str] = field(default_factory=list)
    cli_commands: List[str] = field(default_factory=list)
    expected_runtime: str = ""


@dataclass
class VerificationResult:
    tool: str
    status: str  # "PASS", "FAIL", "BLOCKED"
    source_verified: bool = False
    input_validation: bool = False
    output_verified: bool = False
    notes: List[str] = field(default_factory=list)
    original_output: Optional[dict] = None
    mcp_tool_output: Optional[dict] = None


@dataclass
class ResearchReport:
    research_problem: str = ""
    algorithms: List[dict] = field(default_factory=list)
    workflows: List[dict] = field(default_factory=list)
    candidate_operations: List[dict] = field(default_factory=list)
    inputs: List[dict] = field(default_factory=list)
    outputs: List[dict] = field(default_factory=list)
    dependencies: List[str] = field(default_factory=list)
    datasets: List[str] = field(default_factory=list)
    expected_behavior: List[str] = field(default_factory=list)
    relevant_paper_sections: List[str] = field(default_factory=list)