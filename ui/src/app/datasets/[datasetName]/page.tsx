'use client';

import { useEffect, useState, use, useMemo } from 'react';
import { LuImageOff, LuLoader, LuBan } from 'react-icons/lu';
import { FaChevronLeft } from 'react-icons/fa';
import DatasetImageCard from '@/components/DatasetImageCard';
import { Button } from '@headlessui/react';
import AddImagesModal, { openImagesModal } from '@/components/AddImagesModal';
import ImportParquetModal, { openImportParquetModal } from '@/components/ImportParquetModal';
import { TopBar, MainContent } from '@/components/layout';
import { apiClient } from '@/utils/api';
import FullscreenDropOverlay from '@/components/FullscreenDropOverlay';

export default function DatasetPage({ params }: { params: { datasetName: string } }) {
  const [imgList, setImgList] = useState<{ img_path: string }[]>([]);
  const usableParams = use(params as any) as { datasetName: string };
  const datasetName = usableParams.datasetName;
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');

  const [hfParquetPath, setHfParquetPath] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const refreshImageList = (dbName: string) => {
    setStatus('loading');
    console.log('Fetching images for dataset:', dbName);
    apiClient
      .post('/api/datasets/listImages', { datasetName: dbName })
      .then((res: any) => {
        const data = res.data;
        console.log('Images:', data.images);
        // sort
        data.images.sort((a: { img_path: string }, b: { img_path: string }) => a.img_path.localeCompare(b.img_path));
        setImgList(data.images);
        setStatus('success');
      })
      .catch(error => {
        console.error('Error fetching images:', error);
        setStatus('error');
      });
  };
  useEffect(() => {
    if (datasetName) {
      refreshImageList(datasetName);
    }
  }, [datasetName]);

  const PageInfoContent = useMemo(() => {
    let icon = null;
    let text = '';
    let subtitle = '';
    let showIt = false;
    let bgColor = '';
    let textColor = '';
    let iconColor = '';

    if (status == 'loading') {
      icon = <LuLoader className="animate-spin w-8 h-8" />;
      text = 'Loading Images';
      subtitle = 'Please wait while we fetch your dataset images...';
      showIt = true;
      bgColor = 'bg-gray-50 dark:bg-gray-800/50';
      textColor = 'text-gray-900 dark:text-gray-100';
      iconColor = 'text-gray-500 dark:text-gray-400';
    }
    if (status == 'error') {
      icon = <LuBan className="w-8 h-8" />;
      text = 'Error Loading Images';
      subtitle = 'There was a problem fetching the images. Please try refreshing the page.';
      showIt = true;
      bgColor = 'bg-red-50 dark:bg-red-950/20';
      textColor = 'text-red-900 dark:text-red-100';
      iconColor = 'text-red-600 dark:text-red-400';
    }
    if (status == 'success' && imgList.length === 0) {
      icon = <LuImageOff className="w-8 h-8" />;
      text = 'No Images Found';
      subtitle = 'This dataset is empty. Click "Add Images" to get started.';
      showIt = true;
      bgColor = 'bg-gray-50 dark:bg-gray-800/50';
      textColor = 'text-gray-900 dark:text-gray-100';
      iconColor = 'text-gray-500 dark:text-gray-400';
    }

    if (!showIt) return null;

    return (
      <div
        className={`mt-10 flex flex-col items-center justify-center py-16 px-8 rounded-xl border-2 border-gray-700 border-dashed ${bgColor} ${textColor} mx-auto max-w-md text-center`}
      >
        <div className={`${iconColor} mb-4`}>{icon}</div>
        <h3 className="text-lg font-semibold mb-2">{text}</h3>
        <p className="text-sm opacity-75 leading-relaxed">{subtitle}</p>
      </div>
    );
  }, [status, imgList.length]);

  return (
    <>
      {/* Fixed top bar */}
      <TopBar>
        <div>
          <Button className="text-gray-500 dark:text-gray-300 px-3 mt-1" onClick={() => history.back()}>
            <FaChevronLeft />
          </Button>
        </div>
        <div>
          <h1 className="text-lg">Dataset: {datasetName}</h1>
        </div>
        <div className="flex-1"></div>
        <div className="flex items-center gap-2">
          <Button
            className="text-gray-200 bg-slate-600 px-3 py-1 rounded-md"
            onClick={() => openImagesModal(datasetName, () => refreshImageList(datasetName))}
          >
            Add Images
          </Button>
          <Button
            className="text-gray-200 bg-slate-600 px-3 py-1 rounded-md"
            onClick={() => openImportParquetModal(datasetName, () => refreshImageList(datasetName))}
          >
            Import from HF Parquet
          </Button>
        </div>
      </TopBar>
      <MainContent>
        {PageInfoContent}

        {/* Empty dataset: show parquet import inline (in addition to drag/drop) */}
        {status === 'success' && imgList.length === 0 && (
          <div className="mt-6 mx-auto max-w-md rounded-xl border border-gray-700 bg-gray-800/50 p-4">
            <div className="text-sm font-semibold text-gray-200 mb-2">Import from Hugging Face Parquet</div>
            <input
              type="text"
              value={hfParquetPath}
              onChange={e => setHfParquetPath(e.target.value)}
              placeholder="org/repo/path/to/file.parquet"
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg focus:ring-2 focus:ring-gray-600 focus:border-transparent"
              disabled={isImporting}
            />
            <div className="mt-2 text-xs text-gray-400">Uses HF_TOKEN from Settings to access private repos.</div>

            {importError && <div className="mt-2 text-sm text-red-400">{importError}</div>}

            <button
              className={`mt-3 w-full px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors ${
                isImporting || hfParquetPath.trim().length === 0 ? 'opacity-50 cursor-not-allowed' : ''
              }`}
              disabled={isImporting || hfParquetPath.trim().length === 0}
              onClick={async () => {
                setIsImporting(true);
                setImportError(null);
                try {
                  await apiClient.post('/api/datasets/importParquet', {
                    datasetName,
                    hfParquetPath: hfParquetPath.trim(),
                  });
                  await refreshImageList(datasetName);
                } catch (e: any) {
                  setImportError(e?.response?.data?.error || e?.message || 'Import failed');
                } finally {
                  setIsImporting(false);
                }
              }}
            >
              {isImporting ? 'Importing…' : 'Import from HF Parquet'}
            </button>
          </div>
        )}

        {status === 'success' && imgList.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {imgList.map(img => (
              <DatasetImageCard
                key={img.img_path}
                alt="image"
                imageUrl={img.img_path}
                onDelete={() => refreshImageList(datasetName)}
              />
            ))}
          </div>
        )}
      </MainContent>
      <AddImagesModal />
      <ImportParquetModal />
      <FullscreenDropOverlay datasetName={datasetName} onComplete={() => refreshImageList(datasetName)} />
    </>
  );
}
