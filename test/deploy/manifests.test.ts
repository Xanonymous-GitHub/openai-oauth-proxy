import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

interface Manifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: Record<string, unknown>;
}

interface Probe {
  httpGet: { path: string; port: string };
  failureThreshold: number;
  periodSeconds: number;
}

interface Container {
  image: string;
  env: unknown[];
  livenessProbe: Probe;
  ports: unknown[];
  readinessProbe: Probe;
  securityContext: Record<string, unknown>;
  startupProbe: Probe;
  volumeMounts: unknown[];
}

interface PodSpec {
  automountServiceAccountToken: boolean;
  containers: Container[];
  securityContext: Record<string, unknown>;
  terminationGracePeriodSeconds: number;
  volumes: unknown[];
}

interface StatefulSetSpec {
  podManagementPolicy: string;
  replicas: number;
  template: { spec: PodSpec };
  updateStrategy: { type: string };
}

interface NetworkPolicySpec extends Record<string, unknown> {
  egress: unknown[];
}

const kustomizationText = readFileSync(
  "deploy/base/kustomization.yaml",
  "utf8",
);
const kustomization = parseAllDocuments(kustomizationText)[0]?.toJS() as {
  resources: string[];
};
const baseFiles = kustomization.resources.map(
  (resource) => `deploy/base/${resource}`,
);

const manifests = baseFiles.flatMap((path) =>
  parseAllDocuments(readFileSync(path, "utf8")).map(
    (document) => document.toJS() as Manifest,
  ),
);

function manifest(kind: string, name: string): Manifest {
  const found = manifests.find(
    (item) => item.kind === kind && item.metadata.name === name,
  );
  expect(found, `${kind}/${name}`).toBeDefined();
  return found as Manifest;
}

describe("Kubernetes deployment", () => {
  const statefulSet = manifest("StatefulSet", "openai-oauth-proxy");
  const statefulSetSpec = statefulSet.spec as unknown as StatefulSetSpec;
  const podSpec = statefulSetSpec.template.spec;
  const container = podSpec.containers[0];
  if (!container) throw new Error("StatefulSet must define a container");

  it("runs one ordered rolling StatefulSet replica", () => {
    expect(statefulSetSpec.replicas).toBe(1);
    expect(statefulSetSpec.podManagementPolicy).toBe("OrderedReady");
    expect(statefulSetSpec.updateStrategy.type).toBe("RollingUpdate");
  });

  it("enforces pod and container security", () => {
    expect(podSpec.automountServiceAccountToken).toBe(false);
    expect(podSpec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      fsGroup: 10001,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
    });
    expect(container.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 10001,
      runAsGroup: 10001,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      seccompProfile: { type: "RuntimeDefault" },
    });
  });

  it("uses an explicitly non-pullable immutable example and injects tokens only from Secrets", () => {
    expect(container.image).toBe(
      "example.invalid/openai-oauth-proxy@sha256:0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(container.image).not.toContain("ghcr.io");
    expect(container.image).not.toMatch(/:(latest|main|stable)(?:@|$)/);
    expect(container.env).toEqual(
      expect.arrayContaining([
        { name: "DATA_DIR", value: "/data" },
        { name: "CODEX_HOME", value: "/data/codex" },
        {
          name: "BIFROST_PROXY_TOKEN",
          valueFrom: {
            secretKeyRef: {
              name: "openai-oauth-proxy",
              key: "BIFROST_PROXY_TOKEN",
            },
          },
        },
        {
          name: "METRICS_TOKEN",
          valueFrom: {
            secretKeyRef: {
              name: "openai-oauth-proxy",
              key: "METRICS_TOKEN",
            },
          },
        },
      ]),
    );
  });

  it("uses an operator-selected RWO volume and bounded memory-backed tmp", () => {
    const pvc = manifest("PersistentVolumeClaim", "openai-oauth-proxy-data");
    expect(pvc.spec).toMatchObject({ accessModes: ["ReadWriteOnce"] });
    expect(pvc.spec).not.toHaveProperty("storageClassName");
    expect(container.volumeMounts).toEqual([
      { name: "data", mountPath: "/data" },
      { name: "tmp", mountPath: "/tmp" },
    ]);
    expect(podSpec.volumes).toEqual(
      expect.arrayContaining([
        {
          name: "data",
          persistentVolumeClaim: { claimName: pvc.metadata.name },
        },
        {
          name: "tmp",
          emptyDir: { medium: "Memory", sizeLimit: "256Mi" },
        },
      ]),
    );
  });

  it("keeps admin container-only and configures lifecycle probes", () => {
    expect(container.ports).toEqual([
      { name: "http", containerPort: 8080, protocol: "TCP" },
      { name: "admin", containerPort: 8081, protocol: "TCP" },
    ]);
    expect(container.startupProbe.httpGet).toEqual({
      path: "/healthz",
      port: "http",
    });
    expect(container.livenessProbe.httpGet).toEqual({
      path: "/healthz",
      port: "http",
    });
    expect(container.readinessProbe.httpGet).toEqual({
      path: "/readyz",
      port: "http",
    });
    expect(
      container.startupProbe.failureThreshold *
        container.startupProbe.periodSeconds,
    ).toBeGreaterThanOrEqual(120);
    expect(podSpec.terminationGracePeriodSeconds).toBeGreaterThanOrEqual(45);
  });

  it("exposes only the data plane and defines no Ingress", () => {
    const service = manifest("Service", "openai-oauth-proxy");
    expect(service.spec).toMatchObject({
      type: "ClusterIP",
      ports: [{ name: "http", port: 8080, targetPort: "http" }],
    });
    expect(manifests.filter((item) => item.kind === "Service")).toHaveLength(1);
    expect(manifests.some((item) => item.kind === "Ingress")).toBe(false);
    expect(JSON.stringify(service.spec)).not.toContain("8081");
  });

  it("restricts ingress to exact Bifrost and monitoring workloads", () => {
    const policy = manifest("NetworkPolicy", "openai-oauth-proxy");
    expect(policy.spec).toMatchObject({
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "bifrost" },
              },
              podSelector: {
                matchLabels: { "app.kubernetes.io/name": "bifrost" },
              },
            },
            {
              namespaceSelector: {
                matchLabels: { "kubernetes.io/metadata.name": "monitoring" },
              },
              podSelector: {
                matchLabels: { "app.kubernetes.io/name": "prometheus" },
              },
            },
          ],
          ports: [{ protocol: "TCP", port: 8080 }],
        },
      ],
    });
  });

  it("allows only cluster DNS and the documented HTTPS fallback egress", () => {
    const policy = manifest("NetworkPolicy", "openai-oauth-proxy");
    const { egress } = policy.spec as NetworkPolicySpec;
    expect(egress).toEqual([
      {
        to: [
          {
            namespaceSelector: {
              matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
            },
            podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
          },
        ],
        ports: [
          { protocol: "UDP", port: 53 },
          { protocol: "TCP", port: 53 },
        ],
      },
      { ports: [{ protocol: "TCP", port: 443 }] },
    ]);
    const policyText = readFileSync("deploy/base/networkpolicy.yaml", "utf8");
    expect(policyText).toContain("FQDN-aware CNI");
    expect(policyText).toContain("OpenAI HTTPS");
  });
});

describe("deployment examples", () => {
  it("keeps the non-secret example out of the applied base", () => {
    expect(kustomization.resources).toEqual([
      "pvc.yaml",
      "service.yaml",
      "statefulset.yaml",
      "networkpolicy.yaml",
    ]);
    expect(manifests.some((item) => item.kind === "Secret")).toBe(false);
    expect(kustomizationText).not.toContain("secret.example.yaml");
    const secret = readFileSync("deploy/base/secret.example.yaml", "utf8");
    expect(secret).toContain("NOT_A_SECRET");
  });

  it("uses the exact Bifrost built-in OpenAI provider shape", () => {
    const bifrost = JSON.parse(
      readFileSync("deploy/bifrost/config.example.json", "utf8"),
    );
    expect(bifrost).toEqual({
      providers: {
        openai: {
          keys: [
            {
              name: "oauth-proxy",
              value: "env.OPENAI_PROXY_TOKEN",
              models: ["*"],
              weight: 1,
            },
          ],
          network_config: {
            base_url:
              "http://openai-oauth-proxy.namespace.svc.cluster.local:8080",
            allow_private_network: true,
          },
        },
      },
    });
  });

  it("documents encrypted storage and release digest updates", () => {
    const readme = readFileSync("deploy/README.md", "utf8");
    expect(readme).toContain("encryption at rest");
    expect(readme).toContain("immutable OCI digest");
    expect(readme).toContain("after every image build");
    expect(readme).toContain("repository@sha256");
    expect(readme).toContain("kustomization.yaml");
    expect(readme).toMatch(/must replace|replacement is required/i);
  });

  it("keeps Bifrost's base URL at the origin and prevents a doubled v1 path", () => {
    const documentation = [
      "README.md",
      "deploy/README.md",
      "docs/superpowers/specs/2026-07-11-codex-oauth-proxy-design.md",
      "docs/superpowers/plans/2026-07-11-codex-oauth-proxy.md",
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(documentation).not.toContain(
      "openai-oauth-proxy.namespace.svc.cluster.local:8080/v1",
    );
    expect(documentation).not.toContain("/v1/v1");
    expect(documentation).toContain("Bifrost appends");
  });
});
