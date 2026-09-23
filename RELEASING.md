# Releasing

Releases are published to npm by `.github/workflows/release.yml` when a GitHub
release is published. Nobody publishes from a laptop.

## One-time setup

The package is `@dibbla/sdk-ts`, owned by the `dibbla` npm organization. (It was
`@dibbla-agents/sdk-ts` up to 0.0.1, which was published from a personal
account and could not connect; see CHANGELOG.md.)

1. **First publish, by hand.** npm only lets you attach a trusted publisher
   to a package that exists, so an owner of the `dibbla` org publishes 0.1.0
   once, from a clean checkout of the release commit:

   ```sh
   npm ci && npm run build && npm test && npm run conformance:packed
   npm publish --access public
   ```

2. **Add the trusted publisher.** On npmjs.com, under the package settings:
   - Publisher: GitHub Actions
   - Organization: `dibbla-agents`, repository: `sdk-ts`
   - Workflow: `release.yml`

   Then, in the same settings, require trusted publishing and disallow tokens,
   so no one can publish from a laptop again.

3. **Retire the old name.** An owner of `@dibbla-agents/sdk-ts` runs:

   ```sh
   npm deprecate @dibbla-agents/sdk-ts "Moved to @dibbla/sdk-ts; 0.0.1 cannot connect"
   ```

From then on the workflow publishes over OIDC. There is no npm token to store
or rotate, and every version carries a provenance attestation linking it to
the commit and workflow run that built it.

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
