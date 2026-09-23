# Releasing

`@dibbla/sdk-ts` is owned by the `dibbla` npm organization and published only
by CI (`.github/workflows/release.yml`). Nobody publishes from a laptop.

## Cutting a release

1. In a pull request, bump `version` in `package.json` (semver; still 0.x, so
   a minor bump may break) and add a `## <version>` section to `CHANGELOG.md`.
2. Merge it to `main`.

On that push, the release workflow sees that the version isn't on npm yet and:

1. runs the unit tests, the conformance suite against sdk-go, and the suite
   against the packed package through `require` and `import`
2. publishes with a provenance attestation
3. tags `v<version>` and creates the GitHub release from the changelog section
4. waits for npm to serve the new version, installs it, and runs the
   conformance suite against the installed package

A push to `main` that doesn't change `version` publishes nothing. If a
release run fails part-way, fix the cause and re-run it from the Actions tab
(or `workflow_dispatch`); versions already on npm are skipped.

## Trusted publishing (one-time)

The workflow authenticates to npm over OIDC as a trusted publisher. No npm
token exists anywhere. The trust relationship lives on the package, and a
`dibbla` owner creates it once (npm >= 11.10, with 2FA):

```sh
npx npm@latest trust github @dibbla/sdk-ts --file release.yml --repo dibbla-agents/sdk-ts --allow-publish
npx npm@latest trust list @dibbla/sdk-ts
```

If the workflow file is renamed, the trust relationship must be updated to
match, or publishing fails with a 404/403 from the registry.

## History

`0.1.0` was published by hand (by `joed_dibbla`, from `main` at `0168067`),
because a trust relationship can only be attached to a package that exists.
The old name `@dibbla-agents/sdk-ts` belongs to a personal account and its
only version, 0.0.1, cannot connect. It should be deprecated:

```sh
npm deprecate @dibbla-agents/sdk-ts "Moved to @dibbla/sdk-ts; 0.0.1 cannot connect"
```

## Keeping parity with sdk-go

The conformance suite is how the two SDKs stay in step. Any sdk-go change
that adds or changes an event or payload should either ship the matching
sdk-ts change, or open a linked sdk-ts ticket and extend the scenarios so the
gap shows up in `conformance/known-gaps.json`. See
[conformance/README.md](conformance/README.md).
