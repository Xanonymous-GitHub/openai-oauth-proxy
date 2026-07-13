# Kubernetes deployment

The base deploys one ordered StatefulSet replica. It exposes only port 8080 through a ClusterIP Service; the application binds the admin listener to loopback on port 8081 for `kubectl port-forward` access. `/data` is the only persistent writable mount, while `/tmp` is a bounded memory-backed volume.

## Installation requirements

The base intentionally omits `storageClassName`. Before applying it, ensure the cluster default StorageClass provides encryption at rest or select an encryption-backed StorageClass in an overlay. The PVC contains OAuth credentials and application state and must be backed up and handled as sensitive data.

Create the `openai-oauth-proxy` Secret separately with independent random values of at least 32 characters for `BIFROST_PROXY_TOKEN` and `METRICS_TOKEN`. `base/secret.example.yaml` contains invalid, non-secret markers and is deliberately excluded from `base/kustomization.yaml`.

Replace the example `namespace` in `deploy/bifrost/config.example.json` with the workload namespace (or manage it with an overlay). Bifrost `OPENAI_PROXY_TOKEN` must use the same value as the proxy's `BIFROST_PROXY_TOKEN`; `METRICS_TOKEN` remains independent. The Bifrost base URL intentionally names the proxy origin without `/v1` because Bifrost appends the incoming `/v1/*` path.

Install with `kubectl apply -k deploy/base`. Upgrade by replacing the immutable image digest after a verified multiarch build and reapplying. Rollback by restoring the previous digest and reapplying. Use `kubectl port-forward pod/openai-oauth-proxy-0 8081:8081` for device login and logout; never expose port 8081 through a Service.

## Image releases

The applied base always names an explicit image repository and immutable OCI digest. The current pin is the Task 13 multi-platform OCI digest. The release workflow must build and publish both target platforms, inspect the published manifest-list digest, and update `base/statefulset.yaml` after every image build before applying or releasing the manifests. Never replace the digest with a mutable tag or an unverified local digest.

## Network egress

The base denies egress other than cluster DNS and TCP 443. App Server requires OpenAI HTTPS access. Plain Kubernetes NetworkPolicy cannot constrain that traffic by hostname, so the base uses broad TCP 443 as a documented fallback. Production installations should replace the fallback with an FQDN-aware CNI policy for the required OpenAI destinations or route HTTPS through a controlled egress proxy.
