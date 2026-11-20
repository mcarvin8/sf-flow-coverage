# summary

Generate starter Apex tests for Flows.

# description

Reads each Flow's metadata file from the project and writes an Apex test class named `<Flow>_FlowTest` that runs it: record-triggered Flows get a record built from the trigger object and entry criteria, autolaunched Flows are started with Flow.Interview and their input variables, and platform event Flows publish the event. When a target org is available (--target-org or a default org), the command describes each object the test creates and fills in its required fields, the fields the entry criteria need, and parent records (and their parents) for required lookups.

Entry criteria are read as one condition, whether they are filters (with AND, OR, or custom logic) or a formula. The command meets one branch of an OR, and handles comparisons with literals, other fields, `$User.Id`, and `TODAY()`; `$Record__Prior` values in update tests; and fields on related records, which it sets on the parent record it inserts.

For record-triggered Flows, the command follows the Flow's elements for the record the test creates, deciding each decision the record settles (including formula resources, and lookups on data the test doesn't create, which find nothing in an Apex test). It asserts the fields the Flow is certain to set and the records it is certain to create. When the Flow is certain to stop the save with a custom error, the test expects that error, and a second test sets the fields that avoid it. For autolaunched Flows, it asserts output variables the Flow is certain to set. What the Flow does only on a decision outcome the command can't predict gets commented-out assertions. The generated tests have TODOs for anything the command can't fill in.

Only Apex tests count toward deploying Flows as active, so this command generates Apex, not Flow Builder tests.

# examples

- Generate a test for one Flow:

  <%= config.bin %> <%= command.id %> --flow Account_After_Save

- Generate tests for every active Flow the org has no coverage for:

  <%= config.bin %> <%= command.id %> --uncovered --target-org prod

- Preview without writing files:

  <%= config.bin %> <%= command.id %> --flow Account_After_Save --dry-run

# flags.target-org.summary

Org used to find uncovered Flows (--uncovered) and to describe objects so generated records set their required fields.

# flags.flow.summary

Flow API name to generate a test for.

# flags.uncovered.summary

Generate tests for every active Flow in the target org that no Apex test runs.

# flags.project-dir.summary

Salesforce DX project to read Flow metadata from.

# flags.output-dir.summary

Directory to write test classes to. Defaults to the default package directory's main/default/classes.

# flags.force.summary

Overwrite test classes that already exist.

# flags.dry-run.summary

Show what would be generated without writing files.

# error.noInput

Provide --flow or --uncovered.

# error.uncoveredNeedsOrg

--uncovered needs --target-org (or a default org) to find uncovered Flows.
