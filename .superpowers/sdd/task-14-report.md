# Task 14 Report: Deliver The Single-Replica Kubernetes Deployment

## Status

Complete. Task 14 adds a one-replica ordered StatefulSet, operator-selected encrypted `ReadWriteOnce` storage, locked-down pod and container security, data-plane-only service exposure, exact workload ingress, constrained egress with a documented HTTPS fallback, and the Bifrost built-in `openai` provider fixture.

Implementation commit: `29b4a7bbc5b6fd88b51a26bceeb4dbbc5552dee1` (`deploy: add Kubernetes resources`).

## Files

- Added `deploy/base/kustomization.yaml` with only the PVC, Service, StatefulSet, and NetworkPolicy in the applied base; the example Secret is excluded.
- Added `deploy/base/statefulset.yaml` with one ordered rolling replica, the Task 13 OCI digest, non-root/read-only security, Secret references, lifecycle probes, 45-second termination, persistent `/data`, and bounded memory-backed `/tmp`.
- Added `deploy/base/service.yaml` with one ClusterIP port, TCP 8080, and no admin exposure.
- Added `deploy/base/networkpolicy.yaml` with exact Bifrost and Prometheus namespace/pod ingress selectors, cluster DNS egress, broad TCP 443 fallback egress, and no other allowed traffic.
- Added `deploy/base/pvc.yaml` with `ReadWriteOnce`, a 10 Gi request, and no `storageClassName` so an operator can select an encryption-backed default or overlay.
- Added `deploy/base/secret.example.yaml` with invalid `NOT_A_SECRET` markers; it is not referenced by Kustomize.
- Added `deploy/bifrost/config.example.json` with the built-in `openai` provider, `env.OPENAI_PROXY_TOKEN`, exact service FQDN ending in `/v1`, and `allow_private_network: true`.
- Added `deploy/README.md` with encrypted-storage requirements, separate Secret creation, immutable image-release workflow, and the NetworkPolicy FQDN limitation and fallback.
- Added `test/deploy/manifests.test.ts` with 11 YAML-parsing assertions covering workload ordering, security, immutable image and Secret inputs, storage, temporary space, probes, ports, ingress, egress, example exclusion, Bifrost configuration, and release documentation.
- Modified `package.json` to add `yaml@2.9.0` as an exact development dependency.
- Modified `bun.lock` with the corresponding reproducible YAML package resolution.

## RED Evidence

```bash
bunx vitest run test/deploy/manifests.test.ts
```

Result: exit `1`; the suite failed before collecting tests with the expected `ENOENT: no such file or directory, open 'deploy/base/statefulset.yaml'`. The failure demonstrated that the deployment contract could not pass before the manifests existed.

## GREEN Evidence

### Dependency And Focused Manifest Suite

```bash
bun add --dev yaml@2.9.0
```

Result: exit `0`; Bun installed exactly `yaml@2.9.0` and updated `package.json` and `bun.lock`.

```bash
bun install --frozen-lockfile
```

Result: exit `0`; Bun checked `59` installs across `121` packages with no changes.

```bash
bunx vitest run test/deploy/manifests.test.ts
```

Result: exit `0`; `1` test file and all `11` deployment tests passed.

### Render And Kubernetes Client Validation

```bash
kubectl kustomize deploy/base >/tmp/openai-oauth-proxy.yaml
kubectl apply --dry-run=client -f /tmp/openai-oauth-proxy.yaml
```

Result: both commands exited `0`. Kustomize rendered one Service, one PVC, one StatefulSet, and one NetworkPolicy. Client dry-run accepted all four resources:

```text
service/openai-oauth-proxy created (dry run)
persistentvolumeclaim/openai-oauth-proxy-data created (dry run)
statefulset.apps/openai-oauth-proxy created (dry run)
networkpolicy.networking.k8s.io/openai-oauth-proxy created (dry run)
```

### Protocol, Types, Build, Formatting, And Full Suite

```bash
bun run protocol:check
```

Result: exit `0`; Codex protocol generation completed and `git diff --exit-code -- src/codex/generated` found no drift.

```bash
bun run typecheck
```

Result: exit `0`; TypeScript emitted no diagnostics.

```bash
bun run build
```

Result: exit `0`; production TypeScript compilation completed.

```bash
bunx biome check .
```

Result: exit `0`; Biome checked `67` files with no fixes required.

```bash
bun run test
```

Result: exit `0`; all `27` test files and `383` tests passed. The suite included the `11` deployment assertions and the real target-platform production image build/runtime check.

### Graphify

```bash
graphify update .
```

Result: exit `0`; Graphify rebuilt `17,654` nodes, `20,660` edges, and `1,241` communities. `graphify-out/` remained ignored and was not committed or published.

## Commit

```bash
git add package.json bun.lock deploy test/deploy
git commit -m "deploy: add Kubernetes resources"
```

Result: commit `29b4a7bbc5b6fd88b51a26bceeb4dbbc5552dee1` with `11` files changed, `532` insertions, and `1` deletion.

## Self-Review

### Replica And Storage

- `StatefulSet/openai-oauth-proxy` explicitly sets `replicas: 1`, `podManagementPolicy: OrderedReady`, and `updateStrategy.type: RollingUpdate`.
- The external PVC is mounted only at `/data`, requests `ReadWriteOnce`, and omits `storageClassName`; installation documentation requires an encryption-at-rest default StorageClass or overlay.
- `/tmp` is the only other writable mount and uses memory-backed `emptyDir` with `sizeLimit: 256Mi`; it is not persistent.
- Pod `fsGroup: 10001` and `fsGroupChangePolicy: OnRootMismatch` support the application's enforced `0700` directory and `0600` file modes.

### Security

- Pod and container contexts require non-root UID/GID `10001`; both use `RuntimeDefault` seccomp.
- The container has a read-only root filesystem, cannot escalate privileges, and drops `ALL` Linux capabilities.
- `automountServiceAccountToken: false` prevents a service-account token from entering the pod.
- No host paths, privileged mode, host networking, extra capabilities, or literal credential values are present.

### Ports

- The container declares TCP 8080 and TCP 8081, matching the two application listeners.
- Existing configuration fixes the admin listener to `127.0.0.1:8081`; the only Service exposes TCP 8080, and the applied base contains no admin Service or Ingress.
- Bifrost and monitoring share data-plane port 8080, with independent bearer-token enforcement at the application layer.

### Probes And Drain

- Startup and liveness probes use `/healthz` on named port `http`; readiness uses auth-aware `/readyz`.
- Startup permits `24` failures at five-second intervals, providing a 120-second initialization window before liveness can act.
- Liveness reflects terminal supervisor failure rather than transient recovery, as defined by the existing `/healthz` behavior.
- `terminationGracePeriodSeconds: 45` leaves 15 seconds beyond the application's 30-second bounded drain before Kubernetes force termination.

### Secret Handling

- `BIFROST_PROXY_TOKEN` and `METRICS_TOKEN` use only `secretKeyRef` entries for Secret `openai-oauth-proxy`; the StatefulSet contains no values.
- `secret.example.yaml` uses the short invalid marker `NOT_A_SECRET`, causing application validation to fail closed if somebody applies it unchanged.
- The example Secret is deliberately absent from `kustomization.yaml`, so applying the base cannot deploy example values.

### Network Policy And HTTPS Fallback

- Ingress requires both namespace and pod labels: `bifrost` plus `app.kubernetes.io/name=bifrost`, or `monitoring` plus `app.kubernetes.io/name=prometheus`, and permits only TCP 8080.
- Egress permits UDP/TCP 53 only to `kube-system` pods labelled `k8s-app=kube-dns`.
- The only other egress is broad TCP 443, which keeps required OpenAI HTTPS reachable by App Server while denying other ports and protocols.
- Manifest comments and `deploy/README.md` state that plain NetworkPolicy cannot select FQDNs and require an FQDN-aware CNI rule or controlled egress proxy in production when hostname-level enforcement is needed.

### Bifrost

- The fixture retains the built-in provider key `openai`; it does not create a custom provider.
- Its sole key uses `env.OPENAI_PROXY_TOKEN`, all models, weight `1`, exact base URL `http://openai-oauth-proxy.namespace.svc.cluster.local:8080/v1`, and `allow_private_network: true`.
- No token value is committed in the Bifrost fixture.

### Image Digest

- The applied StatefulSet names explicit repository `ghcr.io/xanonymous/openai-oauth-proxy` and Task 13 manifest-list digest `sha256:8fe334910f67b204e35aebbc173dea29a4678f5038bb1d7f7e2fc2b8336a306e`.
- The image field has no mutable tag or placeholder.
- Release documentation requires every subsequent multi-platform build to be published and inspected before replacing the applied immutable digest.

### Scope

- Implementation is limited to Task 14 deployment manifests and documentation, the Bifrost configuration fixture, manifest tests, and the exact YAML development dependency and lock update.
- No application runtime, API, protocol, Dockerfile, generated source, credentials, graph artifacts, cluster resources, or unrelated files changed.
- No image, manifest, commit, graph, or branch was pushed or published.

## Concerns

- No blocking source implementation concern remains.
- Task 13 produced the pinned OCI archive locally; a real rollout requires that exact digest to be published under `ghcr.io/xanonymous/openai-oauth-proxy`. Publishing was intentionally outside Task 14 and no push was performed.
- The exact DNS and monitoring selectors assume standard `k8s-app=kube-dns` and `app.kubernetes.io/name=prometheus` labels. Clusters using NodeLocal DNSCache or different monitoring labels need an overlay before rollout.
- Broad TCP 443 is intentionally a fallback, not hostname isolation. Production environments requiring destination restriction need an FQDN-aware CNI or controlled egress proxy.
- Validation used Kustomize and Kubernetes client dry-run, not admission against a live production cluster; cluster-specific policies and StorageClass behavior remain installation checks.
- Graphify reported its existing non-blocking version warning: installed skill `0.4.3`, package `0.9.4`.
