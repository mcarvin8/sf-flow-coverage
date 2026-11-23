---

name: flowcov-fix-tests
description: Use when the user asks to fix, finish, or get passing the Apex tests that `sf flowcov scaffold` generated for Salesforce Flows, to "work through the flowcov TODOs", or to raise Flow test coverage toward "Deploy processes and flows as active" in a Salesforce DX project. Generates or reads the tests with the sf-flow-coverage CLI plugin, fills in their TODOs from the Flow metadata, deploys and runs them in a sandbox or scratch org, fixes what fails because of the test's data, and reports what needs a change in the org instead. Requires the Salesforce CLI with the sf-flow-coverage plugin and an authenticated sandbox or scratch org.
license: MIT
---

# Fix the Flow tests sf-flow-coverage generates

`sf flowcov scaffold` writes a starter Apex test for each Flow. It fills in what it can work out from the Flow and the org's metadata, and leaves a TODO for the rest. This skill finishes the job: it reads each test's TODOs, fills them in from the Flow's metadata, runs the tests, and fixes the ones that fail because of the test's data.

Some failures can't be fixed in a test, because they come from how the org is set up: a field the test user can't see, an approval process, a record type the user can't use. Report those for the user to fix in the org instead of working around them.

## Rules

- **Work only in a sandbox or scratch org.** Before deploying anything, check the target org with `sf data query -q "SELECT IsSandbox FROM Organization" -o <org> --json`. If `IsSandbox` is false, stop and tell the user. A scratch org reports true.
- **Change only the generated test classes** (`*_FlowTest.cls`). Never change the Flow under test, other Apex, validation rules, permissions, or any other metadata, in the project or in the org.
- **Keep the tests honest.** A test must run the Flow the way the org would and assert what the Flow does:
  - Don't catch exceptions so that a test passes. Catching the error the Flow is meant to raise is fine, when the test asserts that it was raised and what it says:

    ```apex
    try {
        update testRecord;
        Assert.fail('Handover_Items_Not_Closed should block this save');
    } catch (DmlException e) {
        Assert.isTrue(e.getMessage().contains('Close all handover items'), e.getMessage());
    }
    ```

    Catch only that exception type, and assert the message.
  - Don't remove or weaken an assertion only because it fails. Check the expected value against the Flow's elements first.
  - Don't use `@IsTest(SeeAllData=true)` or hard-coded record Ids.
- **Don't overwrite edits.** Run `scaffold` with `--force` only for classes the user hasn't edited by hand, or when the user asks. The same goes for a test class already in the org: see "Deploy conflicts" in Step 4.
- **Keep org data in this session.** Don't paste field values, record data, or error output from the org into issues, pull requests, or anywhere outside the conversation.

## Step 1: Check prerequisites

Run each `sf` command on its own. Don't chain several in one shell line with `&&` or pipes: on Windows, a chained `sf` command can fail with `'C:\Program' is not recognized` when it's run from Git Bash.

1. Confirm the project has an `sfdx-project.json`, and note its default package directory.
2. Confirm the plugin is installed: `sf plugins inspect sf-flow-coverage`. If it isn't, ask the user before running `sf plugins install sf-flow-coverage`.
3. Ask which org to use if the user didn't say, and check it's a sandbox or scratch org (see Rules).

## Step 2: Generate or list the tests

Run scaffold with `--json` for the Flows the user named, or for every uncovered Flow:

```sh
sf flowcov scaffold --flow <FlowName> --target-org <org> --json
sf flowcov scaffold --uncovered --target-org <org> --json
```

The result lists each created class with its TODOs:

```json
{
  "flowName": "Job_Flow",
  "className": "Job_Flow_FlowTest",
  "path": "...",
  "todos": [{ "method": "runsFlowOnCreate", "kind": "validation rule", "text": "validation rule: Needs_Parent (...)" }]
}
```

- A TODO with no `method` comes from the class header and applies to the whole class.
- `kind` says what the TODO is about. See [references/todos.md](references/todos.md) for what to do with each kind.
- Classes that already exist are listed under `skipped`. Work on those files as they are.

## Step 3: Fill in the TODOs

For each class with TODOs, one class at a time:

1. Read the test class and the Flow's `.flow-meta.xml`. Its path is under the package directory, in a `flows` folder, named `<FlowName>.flow-meta.xml`.
2. For each TODO, follow [references/todos.md](references/todos.md). Read whatever metadata the TODO points to, such as the validation rule's formula or the lookup filter, and set the field values that meet it.
3. Where the class only checks that the record was saved, add assertions for what the Flow does:
   - the fields it sets
   - the records it creates
   - the custom error it raises

   Base them on the Flow's elements for the data the test sets. Leave a TODO for an outcome you can't work out.
4. Remove each TODO comment once it's handled. Leave the TODOs that need a change in the org, and add the reason.
5. Update the class header. Once no TODOs are left for you, remove its line "Replace the TODOs with real data and assertions on what the Flow does." In its place, briefly say what the tests cover, and anything they can't, such as a fault path no test can trigger.

## Step 4: Deploy and run the tests

Deploy only the classes you changed, then run them:

```sh
sf project deploy start --source-dir <path/to/Class_FlowTest.cls> --target-org <org> --wait 10
sf apex run test --class-names <Class_FlowTest> --target-org <org> --code-coverage --result-format json --wait 10
```

`--code-coverage` makes Salesforce record the Flow coverage these tests give.

**Deploy conflicts.** If the deploy stops because the class in the org differs from the one you're deploying, don't add `--ignore-conflicts` straight away:

1. Retrieve the org's copy to a scratch folder, without touching the project. For example, run `sf project retrieve start --metadata ApexClass:<Class_FlowTest> --target-org <org> --target-metadata-dir <scratch folder> --unzip`.
2. Compare it with your version.
3. Overwrite it with `--ignore-conflicts` only when one of these is true:
   - The org's copy is an unedited generated version: it still has the generated header and TODOs, and no methods or assertions someone wrote by hand.
   - The user agrees.
4. Otherwise stop and show the user the differences.

## Step 5: Fix failures

For each failing method, read the error and look it up in [references/failures.md](references/failures.md):

- **Fixable in the test:** change the test's data and go back to Step 4. Try at most three times per class. Then stop, and report what you tried.
- **Needs a change in the org:** don't work around it. Note what the org needs, such as a permission set granting a field or the record type assigned to the user's profile, and move on.
- **The Flow doesn't do what the assertion expects:** check the Flow's elements again. If the Flow really behaves differently from what the test expected, fix the assertion and say so in the report. If the Flow looks wrong, report it for the user instead of changing the Flow.

## Step 6: Report

Finish with a summary:

| Class                | Result            | What changed                                     | Needs in the org                                           |
| -------------------- | ----------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| `Job_Flow_FlowTest`  | Passing           | Set the parent project the validation rule needs |                                                            |
| `Case_Flow_FlowTest` | Org change needed |                                                  | Field-level security on `Case.Secret__c` for the test user |

Then show where coverage stands with `sf flowcov readiness --target-org <org>`, and list the org changes that would make the remaining tests pass.
