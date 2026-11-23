# Backlog

Ideas for sf-flow-coverage, ordered by value within each section. Open an issue before starting anything large. Item numbers stay fixed because pull requests refer to them, so removed items leave gaps.

Suggested first pick: [Markdown output](#9-markdown-output).

## Gaps found in live testing

### 1. Warn when coverage is missing entirely

Done: when results look like missing coverage (no active Flow covered in `readiness` and `transform`, an uncovered Flow in `gate`) and the org has no `FlowTestCoverage` rows at all, the commands warn that tests most likely ran without `--code-coverage` and name the fix.

### 2. Deeper version comparison in the gate

Done: `--content-check` compares each element's and resource's content, the start element, and Flow properties with the file at `--to`, and names the elements that changed. The Tooling API's JSON and the source XML are normalized the same way (key order, one-item lists, value types, nulls and false defaults, canvas positions, and the JSON's end elements and connectors to them) so matching versions don't warn.

### 3. Show the deploy-as-active setting in readiness

Done: `readiness` reads `FlowSettings.enableFlowDeployAsActiveEnabled` and `Organization.IsSandbox`, and says whether the org is working toward the setting or protecting it (or, in a sandbox, that the setting only applies to production).

## Scaffold: fewer TODOs

### 4. More entry-criteria formulas

Entry criteria go through one condition engine: `AND`/`OR`/`NOT`/`IF`/`CASE`, comparisons with literals, other fields, `$User.Id`, and date functions, `$Record__Prior`, `TEXT`/`LEN`/`UPPER`/`LOWER`/`TRIM`/`VALUE` of a field, and fields up to five relationships away. Still left as TODOs:

- Functions of functions (`LEN(TRIM({!$Record.Name}))`), functions of several fields, and `TEXT()` of a number field compared with digits.
- Related fields on users (`{!$Record.Owner.Name}`), and paths through the same object twice (`Account.Parent.Type`), since a test inserts one record per parent object.

### 5. More filter operators

Every filter operator is handled, compared with a literal, another field, `$User.Id`, a constant or formula resource, `$Label`, a field of `$User`, `$Profile`, or `$Organization`, or a `$Setup` custom setting (the test inserts its org-wide default). Still left as TODOs:

- `$Permission` (a test would need a permission set with the custom permission assigned), and variables, whose values the start element can't see.

### 6. Deeper parent records

Required and `IsNull false` lookups get parent records up to five levels deep, polymorphic lookups use the running user or the first object a test can insert, `Profile` lookups use the running user's profile, `Group` and `UserRole` lookups get a record inserted in `System.runAs` (no mixed DML), and `RecordType` and `BusinessHours` lookups read what the org has. Still left as TODOs, with a reason in the comment:

- Required lookups that form a cycle (an object that requires another of its kind, or two objects that each require the other). Neither record can be saved first, so the test needs an existing record or an optional lookup.
- Parents past five levels.
- Queues as owners, which also need a `QueueSobject` for the object; owner lookups use the running user instead.

### 7. Real assertions

Tests follow the Flow's elements and assert what it is certain to do: `$Record` fields, records it creates, output variables, and custom errors (with a second test that avoids the error). Decisions on formula resources, checkbox and picklist defaults, prior values, and empty lookups are decided. Next steps:

- Steer a test down a branch it would otherwise skip, so the Flow's other elements get covered (for example the branch that creates a Task when a crew is too small). Needs the solver to work backwards through formula resources.
- Assert updates to related records.
- Follow loops.

## Generated tests in real orgs

Found by running generated tests in a large real org. Each one makes generated tests fail for reasons outside the Flow under test.

### 16. Report inaccessible fields

Done: `scaffold` collects the fields each Flow reads or writes (on `$Record`, record variables, Get Records results, and the records its elements filter, set, or query), describes any other objects they belong to, and warns about the fields the describe leaves out, which the running user can't see. The generated test lists them in a TODO at the top. The fix stays on the org side: a permission set that grants access, assigned to the user who runs tests.

### 17. Explain approval process conflicts

Done: when a record-triggered Flow submits its record for approval, `scaffold` reads the project's other active Flows and Process Builder processes, and the test gets a TODO naming any that submit the same object's records when they are created (and, for a create-and-update Flow, that the update test's insert already runs it on create). It doesn't work around the conflict: whether a new record should be submitted is the org's business rule. Not detected: approvals submitted by Apex triggers.

### 18. Realistic data for autolaunched Flows

Done for Flows started from a test (autolaunched and scheduled):

- Each text input gets its own placeholder (`'[inputName]'`), so no input holds another's and a Flow that splits one on another doesn't loop until the CPU limit.
- Delete Records elements that find records by filters get a matching record inserted first, comparing with the inputs the test passes; filters it can't meet become a TODO. Deletes with a fault path or an Id filter are left alone.
- Inputs a Send Email action sends to get `flowtest@example.com` (or the running user for `recipientId`), and so does the address field of an input record it sends to.

Still open: record-triggered Flows that delete other records, and Send Email actions that send to a record a Get Records element finds.

### 19. Approval conflicts in other Flows' tests

The update test of any Flow on an object fails with `ALREADY_IN_PROCESS` when other automation submits that object's records for approval both when they're created and when they're updated: the test's insert submits the record, and its update submits it again. Done: the update test of every record-triggered Flow on such an object gets a TODO naming that automation.

### 20. Email to record fields and email alerts

Record-triggered Flows fail with "0 recipients" when a Send Email action sends to a field of `$Record` that the test leaves empty, or when an email alert's recipients (defined in its `WorkflowAlert` metadata: email fields, users, roles) resolve to no one. Done: the test record gets `flowtest@example.com` in each field of `$Record` (or of a parent record) a Send Email action sends to, and in each email field an email alert sends to, with user lookups set to the running user. Alerts are read with the Metadata API (`WorkflowAlert`); an alert that also sends to a user, role, group, the owner, or fixed addresses is left alone. Update tests get the addresses on insert too. A field it can't fill gets a TODO. Not covered: alerts that send to a contact lookup, and Send Email actions that send to a record a Get Records element finds.

### 21. Keep placeholder text out of Id fields

Done: the describe now records each object's Id and lookup fields (for objects it didn't cover, standard fields named like `Id` or `OwnerId` count). Criteria that compare one with text that isn't a record Id become a TODO instead of setting the text. A text input compared with an Id or lookup field whose target the describe didn't give gets `null` and a TODO instead of placeholder text. A text input the Flow assigns to a record variable's `Id` counts as that object's record Id, so the test inserts a record and passes its Id.

### 22. Query everything a Flow reads from input records

Done for fields read through a relationship (`input.Lookup__r.Field__c`): the test fills the lookups behind them with parent records it inserts (up to five deep), with a value in the field read, and `scaffold` describes the objects along the path. A path it can't fill gets a TODO. Still possible: a Flow that overwrites an input record with Get Records results that leave out a field it then reads, which is a problem in the Flow, not the test.

### 23. Record types: picklist values and availability

Done for the record a test saves: the describe's record types (with `available` and the running user's default) are kept, and for objects with two or more record types the user can use and a restricted picklist, `scaffold` reads each record type's picklist values from the UI API. When the restricted picklist values a test saves aren't allowed by the default record type, the test sets a record type that allows them (on insert); when none does, or the criteria name a record type the user can't use, the test gets a TODO. Not covered: parent and input records.

### 24. Validation rules that need parent records, and scheduled Flows on an object

- Done: a validation rule can require a lookup to be filled (for example "a parent project or milestone"). `scaffold` now describes the objects the rules' lookups point to (directly or through a relationship), reads their rules in turn, and the test fills the lookup with a parent record it inserts.
- Checked in a scratch org: a schedule-triggered Flow with an object, started from Apex with `Flow.Interview`, runs (active or draft) but always with an empty `$Record`, and `SObjectRowId` isn't an input it accepts. "Missing required input parameter: SObjectRowId" comes from an email alert inside the Flow, whose record Id input is `{!$Record.Id}`. A test can't set `$Record`, so the generated test's TODO says to move the logic to an autolaunched subflow that takes the record as an input, and test that instead. Nothing more to build here.

## CI and reporting

### 8. `sf flowcov transform`

Done: writes SonarQube generic, Cobertura, and lcov reports, one line per element. Possible next steps: decision outcomes as branches (Cobertura `branch-rate`, lcov `BRDA`) if Salesforce ever reports which outcomes ran, and merging with Apex coverage reports into a single file.

### 9. Markdown output

Done: `readiness` and `gate` take `--output-format markdown` and print one Markdown document (tables, warnings as GitHub alerts) to standard output, for a pull request comment or `>> "$GITHUB_STEP_SUMMARY"`.

### 11. Gate exclusions

Done: `gate` skips Flows matched by a `.flowcovignore` file in the project directory or by `--exclude`, matching Flow API names or file paths, with the pattern (and its `# reason`) in the Reason column. `readiness` still counts every Flow, since Salesforce does.

## Smaller items

### 12. List uncovered elements

Done: `readiness` and `gate` list the elements no test ran, compared with the org version's content. `transform` (#8) builds on the same element coverage.

### 13. Process Builder notice

Done: `readiness` labels Process Builder processes (`Workflow`, `CustomEvent`, and `InvocableProcess` process types), counts them, and suggests migrating them with Migrate to Flow; `gate` warns on a changed process, and `scaffold`'s placeholder test says the same.

### 15. Flow Test Mode

When Flow Test Mode leaves beta, check whether its coverage can be queried or counts toward the deploy-as-active requirement. If so, add a second `CoverageSource` implementation. Don't generate Flow test metadata until then: it requires the beta in every target org.

## Not planned

Kept so the reasoning isn't lost if they come up again.

- **10. Native GitHub Action.** `@salesforce/core` logs with pino, which breaks inside a bundled, frozen GitHub Action. The plugin already runs in any CI that has the Salesforce CLI.
- **14. Core package.** Every useful result needs an authenticated org connection, which the CLI provides. Scripts that already have a connection can use the plugin's exported functions (`src/index.ts`); `OrgCoverageSource` only needs a Tooling API query function.
