# Kubernetes deployment

The base deploys one ordered StatefulSet replica. It exposes only port 8080 through a ClusterIP Service; the application binds the admin listener to loopback on port 8081 for `kubectl port-forward` access. `/data` is the only persistent writable mount, while `/tmp` is a bounded memory-backed volume.

## Installation requirements

The base intentionally omits `storageClassName`. Before applying it, ensure the cluster default StorageClass provides encryption at rest or select an encryption-backed StorageClass in an overlay. The PVC contains OAuth credentials and application state and must be backed up and handled as sensitive data.

Create the `openai-oauth-proxy` Secret separately with independent random values of at least 32 characters for `BIFROST_PROXY_TOKEN` and `METRICS_TOKEN`. `base/secret.example.yaml` contains invalid, non-secret markers and is deliberately excluded from `base/kustomization.yaml`.

## Image releases

The applied base always names an explicit image repository and immutable OCI digest. The current pin is the Task 13 multi-platform OCI digest. The release workflow must build and publish both target platforms, inspect the published manifest-list digest, and update `base/statefulset.yaml` after every image build before applying or releasing the manifests. Never replace the digest with a mutable tag or an unverified local digest.

## Network egress

The base denies egress other than cluster DNS and TCP 443. App Server requires OpenAI HTTPS access. Plain Kubernetes NetworkPolicy cannot constrain that traffic by hostname, so the base uses broad TCP 443 as a documented fallback. Production installations should replace the fallback with an FQDN-aware CNI policy for the required OpenAI destinations or route HTTPS through a controlled egress proxy.
