export const RESERVED_STATUSES = ["created", "finished"] as const;
export type ReservedStatus = (typeof RESERVED_STATUSES)[number];

export type SectionPresence = "Mandatory" | "Optional";

export interface SectionDef {
  name: string;
  description?: string;
  /** Defaults to "Mandatory" when omitted. */
  presence?: SectionPresence;
  sections?: SectionDef[];
}

export interface TypeDef {
  sections?: SectionDef[];
}

export interface TaskConfig {
  statuses: string[];
  priorities: string[];
  types: Record<string, TypeDef>;
}

export interface TaskFrontmatter {
  id: string;
  group?: string;
  title: string;
  type: string;
  status: string;
  priority?: string;
  created_at: string;
  updated_at: string;
  tags?: string[];
  dependencies?: string[];
  based_on?: string[];
  [key: string]: unknown;
}

export interface TaskSummary {
  path: string;
  title: string;
  status: string;
  priority?: string;
  type: string;
  group?: string;
}

export interface TaskFull {
  path: string;
  frontmatter: TaskFrontmatter;
  sections: SectionNode[];
}

export interface SectionNode {
  name: string;
  kind: "heading" | "list";
  checkbox?: " " | "x" | null;
  content: string;
  children: SectionNode[];
}

export interface CheckIssue {
  type:
    | "missing_section"
    | "duplicate_section"
    | "unrecognized_status"
    | "unrecognized_priority"
    | "unrecognized_type"
    | "broken_dependency"
    | "broken_based_on"
    | "group_mismatch";
  message: string;
  path?: string;
}

export interface CheckReport {
  path: string;
  ok: boolean;
  issues: CheckIssue[];
}

export interface GroupInfo {
  group: string;
  path: string;
  created_at: string;
  updated_at: string;
  body: string;
}
