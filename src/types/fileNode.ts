export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  extension?: string;
  size?: number;
  modifiedAt?: string;
  children?: FileNode[];
}
