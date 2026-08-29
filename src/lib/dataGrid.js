import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

const DATA_GRID_LOCALE_TEXT = {
  page: '頁',
  more: '更多',
  to: '至',
  of: '共',
  nextPage: '下一頁',
  lastPage: '最後一頁',
  firstPage: '第一頁',
  previousPage: '上一頁',
  pageSizeSelectorLabel: '每頁顯示：',
  noRowsToShow: '尚無資料。',
  noMatches: '找不到符合條件的資料。'
};

const DATA_GRID_THEME = themeQuartz.withParams({
  borderColor: '#d8dee6',
  headerBackgroundColor: '#f3f6f9',
  headerFontSize: 15,
  headerFontWeight: 700,
  rowBorder: { color: '#e4e8ed' },
  rowHoverColor: '#f8fafc',
  fontSize: 15,
  rowHeight: 64,
  headerHeight: 56,
  paginationPanelHeight: 56
});

const DATA_GRID_DEFAULT_COL_DEF = {
  sortable: true,
  resizable: false,
  wrapText: true,
  autoHeight: true,
  suppressHeaderMenuButton: true
};

export function dataGridProps(className, { fixedHeight = false, hidePaginationPanel = false } = {}) {
  const defaultColDef = fixedHeight
    ? { ...DATA_GRID_DEFAULT_COL_DEF, wrapText: false, autoHeight: false }
    : DATA_GRID_DEFAULT_COL_DEF;

  return {
    className: `data-grid ${className}`,
    theme: DATA_GRID_THEME,
    defaultColDef,
    pagination: !hidePaginationPanel,
    paginationPageSize: 12,
    paginationPageSizeSelector: [12, 24, 48],
    localeText: DATA_GRID_LOCALE_TEXT,
    domLayout: fixedHeight ? 'normal' : 'autoHeight',
    rowHeight: fixedHeight ? 64 : undefined,
    animateRows: false,
    suppressCellFocus: false
  };
}
