import { getAllDomains } from "../lib/domains";

export default function Legend() {
  const domains = getAllDomains();
  return (
    <div className="legend">
      <div className="legend-group">
        <span className="legend-title">Markers</span>
        <div className="legend-row"><span className="marker marker-pk">PK</span> primary key</div>
        <div className="legend-row"><span className="marker marker-fk">FK</span> foreign key</div>
        <div className="legend-row"><span className="marker marker-u">U</span> unique</div>
      </div>
      <div className="legend-group">
        <span className="legend-title">Domains</span>
        {domains.map((d) => (
          <div key={d.key} className="legend-row">
            <span className="legend-swatch" style={{ background: d.color }} />
            {d.label}
          </div>
        ))}
      </div>
    </div>
  );
}
