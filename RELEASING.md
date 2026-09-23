# Releasing

Releases are published to npm by `.github/workflows/release.yml` when a GitHub
release is published. Nobody publishes from a laptop.

## One-time setup

On npmjs.com, a maintainer of `@dibbla-agents/sdk-ts` adds a trusted
publisher under the package settings:

- Publisher: GitHub Actions
- Organization: `dibbla-agents`, repository: `sdk-ts`
- Workflow: `release.yml`

With that in place the workflow publishes over OIDC. There is no npm token to
store or rotate, and every version carries a provenance attestation linking it
to the commit and workflow run that built it.

## Cutting a release

1. Set `version` in `package.json` (semver; still 0.x, so a minor bump may
   break) and add a `CHANGELOG.md` section. Merge that to `main`.
2. Create a GitHub release with tag `v<version>` on that commit.

The workflow refuses a tag that doesn't match `package.json`. Before
publishing it runs the unit tests, the conformance suite against sdk-go, and
the conformance suite against the packed package through both `require` and
`import`.

## Keeping parity with sdk-go

The conformance suite is how the two SDKs stay in step. Any sdk-go change
that adds or changes an event or payload should either ship the matching
sdk-ts change, or open a linked sdk-ts ticket and extend the scenarios so the
gap shows up in `conformance/known-gaps.json`. See
[conformance/README.md](conformance/README.md).
