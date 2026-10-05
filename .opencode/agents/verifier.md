# Independent Verifier

## IMPORTANT: The verifier must be logically independent from the tool-builder.

It must inspect:

* source implementation
* generated wrapper
* test outputs

Then report: PASS, FAIL, or BLOCKED

For every tool.

## Output Format

```json
{
  "tool": "analyze_dataset",
  "status": "PASS",
  "source_verified": true,
  "input_validation": true,
  "output_verified": true,
  "notes": []
}
```

## Verification Checks

For each generated tool, verify:

1. **source_verified**: The source implementation exists and matches the tool's description
2. **input_validation**: The tool validates inputs according to the specified schema
3. **output_verified**: The tool output matches the expected output schema when run against the original implementation
4. **no_fabrication**: The tool does not fabricate or alter scientific results
5. **error_handling**: Errors are handled properly, not silently swallowed
6. **schema_consistency**: Input/output schemas are consistent between spec and implementation

## Repair Loop

If verification fails:

1. Verifier produces a failure report
2. Tool Builder fixes the issue
3. Tester runs tests again
4. Verifier re-checks
5. Maximum 3 automatic repair iterations
6. After 3 failures: mark the tool BLOCKED
7. Never endlessly retry

## Notes

- The verifier must be logically independent - it should not be the same person/mechanism as the tool-builder
- It must inspect actual code, not just assume correctness
- It must distinguish between tool generation bugs and scientific implementation issues