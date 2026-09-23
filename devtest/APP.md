---
subtitle: Test functions for the TypeScript SDK release checks.
---

# SDK test worker

This app is a test fixture for the Dibbla TypeScript SDK. It adds a small set
of test functions, tool-search and memory providers, and a counting job to
this organization's function registry, so engineers can check a new SDK
release against this environment before it ships.

## Who it is for

Engineers verifying an SDK release. It holds no data of its own and does
nothing unless a workflow calls it.

## FAQ

**Can I use these functions in my own workflows?** Please don't. They exist
to test the SDK and will be removed when testing is done.

**Why does it show up in the function list?** Functions such as `echo`,
`whoami` and `count_job` appear under the server `sdk-ts-devtest` while this
app is running.
