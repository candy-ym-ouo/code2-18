import { formatHour } from '../utils.js';

const OUTCOME = {
  'on-time': '准时',
  late: '逾时',
  wrong: '误投',
  'wrong-late': '误投且逾时'
};

export default function ReportDialog({ report, onClose }) {
  if (!report) return null;
  const delivered = report.routes.reduce((sum, route) => sum + route.letters.length, 0);
  const nextDay = report.generatedNextDay;

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="report-dialog" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div className="report-header">
          <div>
            <p className="eyebrow">第 {report.day} 日航后电报</p>
            <h2 id="report-title">调度结算完成</h2>
          </div>
          <span className={`report-reputation ${report.reputationDelta >= 0 ? 'positive' : 'negative'}`}>
            信誉 {report.reputationDelta >= 0 ? '+' : ''}{report.reputationDelta}
          </span>
        </div>

        <div className="report-stats">
          <div><b>{delivered}</b><span>已投递</span></div>
          <div><b>{report.routes.flatMap((route) => route.letters).filter((letter) => letter.outcome === 'on-time').length}</b><span>准时</span></div>
          <div><b>{report.routes.flatMap((route) => route.letters).filter((letter) => letter.late).length}</b><span>逾时</span></div>
          <div><b>{report.routes.flatMap((route) => route.letters).filter((letter) => letter.wrong).length}</b><span>误投</span></div>
        </div>

        <div className="report-scroll">
          <div className="report-section">
            <h3>航线回报</h3>
            {report.routes.length === 0 && <p className="report-empty">今日没有出港航班，所有邮件都积压了。</p>}
            {report.routes.map((route) => (
              <div className="report-route" key={route.courierId}>
                <div className="report-route-title">
                  <strong>{route.courierName}</strong>
                  <span>{route.letterCount} 封 · {route.totalDistance} km</span>
                </div>
                {route.letters.map((letter) => (
                  <div className="report-delivery" key={letter.letterId}>
                    <code>{letter.letterId}</code>
                    <span>{letter.targetName}</span>
                    <span>{formatHour(letter.arrivalHour)}</span>
                    <b className={`outcome ${letter.wrong ? 'danger' : letter.late ? 'warning' : 'success'}`}>{OUTCOME[letter.outcome]}</b>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {report.relationChanges.length > 0 && (
            <div className="report-section">
              <h3>关系变化</h3>
              {report.relationChanges.map((change) => (
                <div className="relation-change" key={change.key}>
                  <span>{change.firstIslandName} ↔ {change.secondIslandName}</span>
                  <b className={change.delta > 0 ? 'positive' : change.delta < 0 ? 'negative' : ''}>{change.delta > 0 ? '+' : ''}{change.delta}</b>
                  <small>
                    {change.reasons.join('；')}
                    {change.requestedDelta !== undefined && change.requestedDelta !== change.delta ? '（已受关系上下限限制）' : ''}
                  </small>
                </div>
              ))}
            </div>
          )}

          {report.contractEvents?.length > 0 && (
            <div className="report-section">
              <h3>委托合约自动结算</h3>
              {report.contractEvents.map((event) => (
                <div className="relation-change" key={event.id}>
                  <span>{event.contractTitle}（{event.contractId}）</span>
                  <b className={event.delta >= 0 ? 'positive' : 'negative'}>
                    {event.delta >= 0 ? '+' : ''}{Number(event.delta).toFixed(2)}
                  </b>
                  <small>{OUTCOME[event.outcome] || event.outcome} · 快照费率 v{event.rateVersion}</small>
                </div>
              ))}
              <p className="report-empty">
                委托金净额：<b>{Number(report.contractBalance ?? 0).toFixed(2)}</b>（争议可在合约中心重算，原记录保留）
              </p>
            </div>
          )}

          {report.unassignedLetterIds.length > 0 && (
            <div className="report-section report-warning">
              <h3>积压邮件</h3>
              <p>{report.unassignedLetterIds.join('、')} 未出港，信誉与邮资已受到影响。</p>
            </div>
          )}
        </div>

        <div className="report-footer">
          <div>
            <span>信誉 <b>{report.reputationAfter}</b></span>
            <span>邮资 <b>{report.creditsAfter}</b></span>
          </div>
          <button type="button" onClick={onClose}>
            {nextDay ? `进入第 ${nextDay} 日` : '查看本局结果'}
          </button>
        </div>
      </section>
    </div>
  );
}
