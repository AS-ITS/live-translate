export function MeetingPageGroup({
  page,
  isMeetingWorkspace,
  ManagementPage,
  managementProps,
  WorkspacePage,
  workspaceProps,
  DetailPage,
  detailProps,
  children = null
}) {
  return (
    <>
      {page === 'meeting' || page === 'meetings' ? <ManagementPage {...managementProps} /> : null}
      {isMeetingWorkspace ? <WorkspacePage {...workspaceProps} /> : null}
      {page === 'meeting-detail' ? <DetailPage {...detailProps} /> : null}
      {children}
    </>
  );
}
