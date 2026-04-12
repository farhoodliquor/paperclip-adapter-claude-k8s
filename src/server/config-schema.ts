export interface AdapterConfigSchema {
  sections?: AdapterConfigSection[];
}

export interface AdapterConfigSection {
  title: string;
  fields: ConfigFieldSchema[];
}

export type ConfigFieldSchema =
  | TextFieldSchema
  | NumberFieldSchema
  | ToggleFieldSchema
  | SelectFieldSchema
  | TextareaFieldSchema;

export interface TextFieldSchema {
  type: "text";
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  helpLink?: string;
}

export interface NumberFieldSchema {
  type: "number";
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  helpLink?: string;
}

export interface ToggleFieldSchema {
  type: "toggle";
  key: string;
  label: string;
  description?: string;
  helpLink?: string;
}

export interface SelectFieldSchema {
  type: "select";
  key: string;
  label: string;
  description?: string;
  options: { value: string; label: string }[];
  helpLink?: string;
}

export interface TextareaFieldSchema {
  type: "textarea";
  key: string;
  label: string;
  description?: string;
  placeholder?: string;
  helpLink?: string;
}

export function getConfigSchema(): AdapterConfigSchema {
  return {
    sections: [
      {
        title: "Kubernetes",
        fields: [
          {
            type: "text",
            key: "namespace",
            label: "Namespace",
            description: "Kubernetes namespace for Jobs. Defaults to the Deployment namespace.",
          },
          {
            type: "text",
            key: "image",
            label: "Container Image",
            description: "Override the container image used for Job pods. Defaults to the running Deployment image.",
            placeholder: "registry/image:tag",
          },
          {
            type: "select",
            key: "imagePullPolicy",
            label: "Image Pull Policy",
            description: "Image pull policy for the container image.",
            options: [
              { value: "IfNotPresent", label: "IfNotPresent" },
              { value: "Always", label: "Always" },
              { value: "Never", label: "Never" },
            ],
          },
          {
            type: "text",
            key: "kubeconfig",
            label: "Kubeconfig Path",
            description: "Absolute path to a kubeconfig file on disk. Defaults to in-cluster service account auth.",
            placeholder: "/path/to/kubeconfig",
          },
          {
            type: "number",
            key: "ttlSecondsAfterFinished",
            label: "TTL Seconds After Finished",
            description: "Auto-cleanup delay for completed Jobs in seconds. Default: 300.",
          },
          {
            type: "toggle",
            key: "retainJobs",
            label: "Retain Jobs",
            description: "Skip cleanup of completed Jobs for debugging purposes.",
          },
        ],
      },
      {
        title: "Resource Limits",
        fields: [
          {
            type: "text",
            key: "resources.requests.cpu",
            label: "CPU Request",
            description: "CPU request for Job pods (e.g. 100m, 0.5, 1).",
            placeholder: "100m",
          },
          {
            type: "text",
            key: "resources.requests.memory",
            label: "Memory Request",
            description: "Memory request for Job pods (e.g. 128Mi, 512Mi, 1Gi).",
            placeholder: "512Mi",
          },
          {
            type: "text",
            key: "resources.limits.cpu",
            label: "CPU Limit",
            description: "CPU limit for Job pods (e.g. 100m, 0.5, 1).",
            placeholder: "1000m",
          },
          {
            type: "text",
            key: "resources.limits.memory",
            label: "Memory Limit",
            description: "Memory limit for Job pods (e.g. 128Mi, 512Mi, 1Gi).",
            placeholder: "1Gi",
          },
        ],
      },
      {
        title: "Scheduling",
        fields: [
          {
            type: "textarea",
            key: "nodeSelector",
            label: "Node Selector",
            description: "Node selector for Job pods. One key=value per line (e.g. disktype=ssd).",
            placeholder: "disktype=ssd\ngpu=true",
          },
          {
            type: "textarea",
            key: "tolerations",
            label: "Tolerations",
            description: "Tolerations for Job pods as JSON array.",
            placeholder: '[{"key":"node-type","operator":"Equal","value":"gpu","effect":"NoSchedule"}]',
          },
          {
            type: "textarea",
            key: "labels",
            label: "Labels",
            description: "Extra labels added to Job metadata. One key=value per line.",
            placeholder: "team=ai\nenv=prod",
          },
        ],
      },
    ],
  };
}
