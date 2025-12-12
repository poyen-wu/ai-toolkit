'use client';

import { createGlobalState } from 'react-global-hooks';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { useMemo, useState } from 'react';
import { apiClient } from '@/utils/api';

export interface ImportParquetModalState {
  datasetName: string;
  onComplete?: () => void;
}

export const importParquetModalState = createGlobalState<ImportParquetModalState | null>(null);

export const openImportParquetModal = (datasetName: string, onComplete: () => void) => {
  importParquetModalState.set({ datasetName, onComplete });
};

export default function ImportParquetModal() {
  const [modalInfo, setModalInfo] = importParquetModalState.use();
  const open = modalInfo !== null;

  const [hfParquetPath, setHfParquetPath] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: { row: number; error: string }[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const canImport = useMemo(() => {
    return !isImporting && !!modalInfo?.datasetName && hfParquetPath.trim().length > 0;
  }, [hfParquetPath, isImporting, modalInfo?.datasetName]);

  const onCancel = () => {
    if (isImporting) return;
    setModalInfo(null);
    setError(null);
    setResult(null);
    setHfParquetPath('');
  };

  const doImport = async () => {
    if (!modalInfo?.datasetName) return;
    setIsImporting(true);
    setError(null);
    setResult(null);

    try {
      const data = await apiClient
        .post('/api/datasets/importParquet', {
          datasetName: modalInfo.datasetName,
          hfParquetPath: hfParquetPath.trim(),
        })
        .then(res => res.data);

      setResult(data);
      modalInfo.onComplete?.();
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Import failed');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onCancel} className="relative z-10">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-gray-900/75 transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in"
      />

      <div className="fixed inset-0 z-10 w-screen overflow-y-auto">
        <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
          <DialogPanel
            transition
            className="relative transform overflow-hidden rounded-lg bg-gray-800 text-left shadow-xl transition-all data-closed:translate-y-4 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in sm:my-8 sm:w-full sm:max-w-lg data-closed:sm:translate-y-0 data-closed:sm:scale-95"
          >
            <div className="bg-gray-800 px-4 pt-5 pb-4 sm:p-6 sm:pb-4">
              <div className="text-center">
                <DialogTitle as="h3" className="text-base font-semibold text-gray-200 mb-4">
                  Import from HF Parquet into: {modalInfo?.datasetName}
                </DialogTitle>

                <div className="w-full text-left">
                  <label className="block text-sm font-medium mb-2 text-gray-200">Hugging Face parquet path</label>
                  <input
                    type="text"
                    value={hfParquetPath}
                    onChange={e => setHfParquetPath(e.target.value)}
                    placeholder="org/repo/path/to/file.parquet"
                    className="w-full px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent"
                    disabled={isImporting}
                  />
                  <div className="text-xs text-gray-400 mt-2">
                    Uses the Hugging Face token from Settings (HF_TOKEN) for private repos.
                  </div>

                  {error && <div className="mt-3 text-sm text-red-400">{error}</div>}

                  {result && (
                    <div className="mt-3 text-sm text-gray-200">
                      Imported: <span className="font-mono">{result.imported}</span> · Skipped:{' '}
                      <span className="font-mono">{result.skipped}</span>
                      {result.errors?.length > 0 && (
                        <div className="mt-2 text-xs text-orange-300">
                          {result.errors.length} row(s) had errors. (Check server logs for details.)
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-gray-700 px-4 py-3 sm:flex sm:flex-row-reverse sm:px-6">
              <button
                type="button"
                onClick={doImport}
                disabled={!canImport}
                className={`inline-flex w-full justify-center rounded-md bg-slate-600 px-3 py-2 text-sm font-semibold text-white shadow-xs sm:ml-3 sm:w-auto ${
                  !canImport ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                {isImporting ? 'Importing…' : 'Import'}
              </button>
              <button
                type="button"
                data-autofocus
                onClick={onCancel}
                disabled={isImporting}
                className={`mt-3 inline-flex w-full justify-center rounded-md bg-gray-800 px-3 py-2 text-sm font-semibold text-gray-200 hover:bg-gray-800 sm:mt-0 sm:w-auto ring-0 ${
                  isImporting ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                Close
              </button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}
