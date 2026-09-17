# Workflow extension template

This is a small, copyable extension rather than a generator. It shows the usual
registration shape with one function and one packaged role. Copy the directory
into a project, rename the metadata and function, then edit the role body.


## Run it

From the repository root after installing dependencies and building the package:

```sh
node --test packages/core/examples/workflow-extension-template/extension.test.mjs
```

For a published package, run the same test from this directory after installing
`@marcoscale98/pi-extensible-workflows` in the surrounding project. Copy the directory into a
trusted Pi extension location; Pi auto-discovers its `index.js` entry point.


## Files

- `index.js` registers `greet` and resolves `roles/` from `import.meta.url`.
  Relative role-directory strings are not accepted by the extension API.
- `roles/reviewer.md` is a portable packaged role with no provider or tool
  assumptions.
- `extension.test.mjs` checks registration, function behavior, role packaging,
  and the advanced examples.


## Optional advanced pieces

The dynamic `template-model` alias and `templateAdvisor` setup hook are
optional examples. The hook only changes an agent after the call includes
`{ templateAdvisor: true }`; remove either section if the extension does not
need it. Both features are trusted host code and should be kept under explicit
project policy.
