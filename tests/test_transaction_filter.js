const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../portfolio_static', file), 'utf8');
let query = '';
const body = { innerHTML: '' };
const context = vm.createContext({
  window: {}, transactionRows: [], showHiddenTransactions: false,
  transactionPage: 3, transactionPageSize: 10, editingTxId: null,
  document: { getElementById: id => id === 'transactionNameFilter' ? {value: query} : body },
});
const holdings = read('app-holdings.js');
vm.runInContext(holdings.slice(holdings.indexOf('function normalizeListName('), holdings.indexOf('function holdingChangePct(')), context);
vm.runInContext(read('app-transactions.js'), context);
const run = code => vm.runInContext(code, context);
run(`transactionRows = [
  {id: 1, ticker: 'AAPL', name: 'Apple', hidden: 0},
  {id: 2, ticker: 'MSFT', name: 'Microsoft', hidden: 1},
  {id: 3, ticker: '005930.KS', name: '삼성전자', hidden: 0},
  {id: 4, ticker: 'BRK.B', name: 'Berkshire Hathaway', hidden: 0},
  {id: 5, ticker: 'EMPTY', name: null, hidden: 0},
];`);
query = ' aAp ';
assert.equal(run("visibleTransactionRows().map(t => t.id).join(',')"), '1');
query = '삼성 전자';
assert.equal(run("visibleTransactionRows()[0].id"), 3);
query = 'HATHAWAY';
assert.equal(run("visibleTransactionRows()[0].id"), 4);
query = 'micro';
assert.equal(run("visibleTransactionRows().length"), 0);
run('showHiddenTransactions = true');
assert.equal(run("visibleTransactionRows()[0].id"), 2);
query = 'em';
assert.equal(run("visibleTransactionRows()[0].id"), 5);
query = '   ';
assert.equal(run("visibleTransactionRows().length"), 5);
run('showHiddenTransactions = false');
assert.equal(run("visibleTransactionRows().length"), 4);
run(`
  let balanceInputCount = 0, pagerCount = 0;
  txEndingBalances = rows => { balanceInputCount = rows.length; return new Map(); };
  txViewRow = tx => '<tr><td>' + tx.ticker + '</td></tr>';
  bindTransactionRowActions = () => {};
  renderTransactionPager = count => { pagerCount = count; };
`);
query = 'aapl';
run('renderTransactions(transactionRows, true)');
assert.equal(run('transactionPage'), 1);
assert.equal(run('pagerCount'), 1);
assert.equal(run('balanceInputCount'), 5); // balances must still use the complete ledger
assert.match(body.innerHTML, /AAPL/);
query = 'no match';
run('renderTransactions(transactionRows, true)');
assert.equal(run('pagerCount'), 0);
assert.match(body.innerHTML, /검색 조건에 맞는 거래내역이 없습니다/);
query = '';
run('renderTransactions(transactionRows, true)');
assert.equal(run('pagerCount'), 4);
assert.equal(run('transactionRows.length'), 5);
console.log('transaction filter: ticker/name, case/spacing, hidden rows, empty results, paging and full-ledger balances passed');
