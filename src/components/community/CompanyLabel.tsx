import { ShieldCheck } from "lucide-react";
import "../../styles/community-identity.css";

type Props = { name: string | null; isAdmin?: boolean };

export function CompanyLabel({ name, isAdmin = false }: Props) {
  if (name && isAdmin) {
    return <span className="admin-author-badge" aria-label="Workfolio 인증 관리자"><ShieldCheck size={12} aria-hidden="true" />관리자</span>;
  }
  return <span className="author-company">{name ?? "회사 비공개"}</span>;
}
