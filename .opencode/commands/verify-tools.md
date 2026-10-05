# /verify-tools Command

## Usage

/verify-tools <generated-project>

## Description

Runs the independent verification pipeline on a generated project. This performs:

- Inspection of source implementations
- Inspection of generated wrappers
- Running test outputs
- Reporting PASS/FAIL/BLOCKED status for each tool

## Output

Produces verification-report.json with entries like:

```json
{
  "tool": "place_limit_order",
  "status": "PASS",
  "source_verified": true,
  "input_validation": true,
  "output_verified": true,
  "notes": []
}
```

If verification fails, reports the failure reason and enters the repair loop (maximum 3 automatic iterations before marking BLOCKED).