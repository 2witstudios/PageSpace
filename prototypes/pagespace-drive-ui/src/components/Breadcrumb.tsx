interface Crumb {
  id: string | null;
  title: string;
}

interface BreadcrumbProps {
  driveName: string;
  crumbs: Crumb[];
  onNavigate: (id: string | null) => void;
}

export function Breadcrumb({ driveName, crumbs, onNavigate }: BreadcrumbProps) {
  return (
    <nav className="breadcrumb">
      <button type="button" onClick={() => onNavigate(null)}>
        {driveName}
      </button>
      {crumbs.map((crumb, i) => (
        <span key={crumb.id ?? i}>
          <span className="breadcrumb-sep">/</span>
          <button type="button" onClick={() => onNavigate(crumb.id)} disabled={i === crumbs.length - 1}>
            {crumb.title}
          </button>
        </span>
      ))}
    </nav>
  );
}
