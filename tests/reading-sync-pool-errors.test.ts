import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PoolFailureReasons } from "../src/components/PoolFailureReasons.tsx";

test("Reading sync shows host names and escaped failure reasons", () => {
  const markup = renderToStaticMarkup(createElement(PoolFailureReasons, {
    job: { status: "error", poolErrors: { wsl: "ssh: Connection refused", lisa: "health: <worker busy>" } },
  }));
  assert.match(markup, /Remote host failures/);
  assert.match(markup, /wsl: ssh: Connection refused/);
  assert.match(markup, /lisa: health: &lt;worker busy&gt;/);
});

test("Reading sync handles legacy jobs, queued failures and successful failover", () => {
  assert.equal(renderToStaticMarkup(createElement(PoolFailureReasons, { job: { status: "error" } })), "");
  const poolErrors = { wsl: "staging: disk full" };
  assert.match(renderToStaticMarkup(createElement(PoolFailureReasons, { job: { status: "queued", poolErrors } })), /disk full/);
  assert.equal(renderToStaticMarkup(createElement(PoolFailureReasons, { job: { status: "partial", poolErrors } })), "");
});
