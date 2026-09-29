// Verifies the npm provenance attestation of the version the publish workflow
// just uploaded.
//
// Checks, in order:
//   1. The registry serves the version and advertises an attestation for it
//      (`dist.attestations`), with a sha512 `dist.integrity`.
//   2. Every attestation the registry returns is a Sigstore bundle with a signed
//      DSSE envelope carrying an in-toto statement, and one of them is SLSA
//      provenance v1.
//   3. Each statement's subject digest equals `dist.integrity`. That is what
//      ties the attestation to the tarball a consumer downloads — this script
//      checks *which* artifact was signed, `npm audit signatures` checks the
//      signature itself.
//   4. The provenance build definition names this repository, and the commit
//      being released when GitHub exposes it.
//
// The registry exposes the attestation a moment after the tarball, so the
// version document is polled: VERIFY_ATTEMPTS (default 12) attempts,
// VERIFY_DELAY_MS (default 5000) apart.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
const IN_TOTO_PAYLOAD = 'application/vnd.in-toto+json';

const name = process.env.PACKAGE_NAME || pkg.name;
const version = process.env.PACKAGE_VERSION || pkg.version;
const registry = (
  process.env.NPM_CONFIG_REGISTRY ||
  process.env.npm_config_registry ||
  'https://registry.npmjs.org'
).replace(/\/+$/, '');
const attempts = Number(process.env.VERIFY_ATTEMPTS || 12);
const delayMs = Number(process.env.VERIFY_DELAY_MS || 5000);
const expectedRepository = process.env.GITHUB_REPOSITORY
  ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
  : undefined;
const expectedCommit = process.env.GITHUB_SHA;

let failed = 0;

function report(ok, label, detail) {
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function getJson(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'wraith-protocol-release-check' },
    });
    if (!response.ok) return { status: response.status };
    return { status: response.status, json: await response.json() };
  } catch (error) {
    return { status: 0, error: String(error instanceof Error ? error.message : error) };
  }
}

/** Decodes one attestation into its in-toto statement, or throws. */
function statementOf(attestation) {
  const envelope = attestation?.bundle?.dsseEnvelope;
  if (!envelope?.payload || envelope.payloadType !== IN_TOTO_PAYLOAD) {
    throw new Error(`${attestation?.predicateType ?? 'attestation'} has no in-toto DSSE payload`);
  }
  return JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
}

const versionUrl = `${registry}/${encodeURIComponent(name).replace('%40', '@')}/${version}`;

let dist;
let lastError;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const { status, json, error } = await getJson(versionUrl);
  if (status === 200 && json?.dist) {
    if (json.dist.attestations?.url) {
      dist = json.dist;
      break;
    }
    lastError = `${name}@${version} is published but the registry has no attestation for it`;
  } else if (status === 404) {
    lastError = `${name}@${version} is not in the registry yet`;
  } else {
    lastError = `${versionUrl} returned ${error ?? status}`;
  }
  if (attempt < attempts) {
    console.log(
      `waiting for the registry to expose ${name}@${version} (${attempt}/${attempts}): ${lastError}`,
    );
    await sleep(delayMs);
  }
}

report(
  Boolean(dist),
  `the registry exposes the provenance attestation for ${name}@${version}`,
  lastError,
);
if (!dist) {
  console.error(
    '\nWithout an attestation there is nothing to verify. Check that the publish step ran',
    '`pnpm publish --provenance` with `id-token: write` permission.',
  );
  process.exit(1);
}

const integrity = dist.integrity;
const subjectDigest =
  typeof integrity === 'string' && integrity.startsWith('sha512-')
    ? Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex')
    : undefined;
report(Boolean(subjectDigest), `the published tarball digest is a sha512 digest (${integrity})`);
if (!subjectDigest) process.exit(1);

const advertised = dist.attestations;
if (advertised.provenance?.predicateType) {
  report(
    advertised.provenance.predicateType === SLSA_PROVENANCE_V1,
    `the advertised provenance is SLSA v1 (${advertised.provenance.predicateType})`,
  );
}

const { status, json: bundle } = await getJson(advertised.url);
report(
  status === 200 && Array.isArray(bundle?.attestations) && bundle.attestations.length > 0,
  `the attestation bundle is readable (${advertised.url})`,
  bundle?.attestations ? 'the bundle has no attestations' : `registry returned ${status}`,
);
if (status !== 200 || !Array.isArray(bundle?.attestations)) process.exit(1);

const statements = [];
for (const attestation of bundle.attestations) {
  const type = attestation.predicateType ?? 'unknown predicate';
  const envelope = attestation.bundle?.dsseEnvelope;
  const material = attestation.bundle?.verificationMaterial ?? {};
  report(
    Boolean(envelope?.signatures?.length),
    `attestation is signed (${type})`,
    'the DSSE envelope has no signature',
  );
  report(
    Boolean(material.certificate || material.publicKey),
    `attestation carries verification material (${type})`,
    'the bundle has neither a certificate nor a public key',
  );

  let statement;
  try {
    statement = statementOf(attestation);
  } catch (error) {
    report(false, `attestation decodes to an in-toto statement (${type})`, String(error.message));
    continue;
  }
  statements.push(statement);

  const digest = statement.subject?.[0]?.digest?.sha512;
  report(
    digest === subjectDigest,
    `attestation subject is the published tarball (${type})`,
    `attestation is for ${digest ?? 'no digest'}, registry serves ${subjectDigest}`,
  );
  if (statement.subject?.[0]?.name) {
    console.log(`     subject: ${statement.subject[0].name}`);
  }
}

const provenance = statements.find((statement) => statement.predicateType === SLSA_PROVENANCE_V1);
report(
  Boolean(provenance),
  `the bundle contains an SLSA v1 provenance statement (${SLSA_PROVENANCE_V1})`,
);
if (!provenance) process.exit(1);

const buildDefinition = provenance.predicate?.buildDefinition ?? {};
const workflow = buildDefinition.externalParameters?.workflow ?? {};
if (expectedRepository) {
  report(
    workflow.repository === expectedRepository,
    `the provenance names this repository (${workflow.repository ?? 'missing'})`,
    `expected ${expectedRepository}`,
  );
} else {
  console.log(
    `skip repository check: GITHUB_REPOSITORY is not set (provenance says ${workflow.repository ?? 'nothing'})`,
  );
}

const commit = (buildDefinition.resolvedDependencies ?? [])
  .map((dependency) => dependency?.digest?.gitCommit)
  .find(Boolean);
if (commit && expectedCommit) {
  report(
    commit === expectedCommit,
    `the provenance names the released commit (${commit})`,
    `expected ${expectedCommit}`,
  );
} else if (commit) {
  console.log(`note the provenance was built from commit ${commit} (GITHUB_SHA is not set)`);
} else {
  console.log(
    `note the provenance has no gitCommit digest (the released commit is ${expectedCommit ?? 'unknown'})`,
  );
}

const builder = provenance.predicate?.runDetails?.builder?.id ?? 'unknown builder';
const invocation = provenance.predicate?.runDetails?.metadata?.invocationId;
console.log(`     build: ${builder} ${workflow.path ?? ''}`.trimEnd());
if (invocation) console.log(`     run:   ${invocation}`);

process.exit(failed === 0 ? 0 : 1);
