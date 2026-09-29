// /components/MainComponent.js
'use client';

import React, { useState } from 'react';
import PlugFase from './PlugFase';
import PlayFase from './PlayFase';
import ApiCatalogModal from './ApiCatalogModal';
import '../styles/globals.css';
import { Cpu } from 'lucide-react';

const MainComponent = () => {
  const [apiCatalogOpen, setApiCatalogOpen] = useState(false);

  return (
    <div className="full-screen-app">
        <header className="main-header flex items-center">
          <div className="main-header-content flex items-start sm:items-center gap-3 sm:gap-4">
            <div className="h-12 w-12 sm:h-14 sm:w-14 rounded-xl bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center shadow-lg shadow-primary/20 ring-2 ring-primary/10">
              <Cpu className="h-6 w-6 sm:h-7 sm:w-7 text-primary-foreground" />
            </div>
            <div className="flex-1">
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-foreground text-balance leading-tight">
                Manufacturing Assets Life Cycle PPU Management System (ACSM)
              </h1>
            </div>
          </div>
          <button
            type="button"
            className="main-header-api-btn"
            onClick={() => setApiCatalogOpen(true)}
            title="Inspect the ACSM API catalog"
          >
            APIs
          </button>
        </header>

        <main className="main-content-split">
          <div className="plug-fase-wrapper">
            <PlugFase />
          </div>
          <div className="play-fase-wrapper">
            <PlayFase />
          </div>
        </main>
        <ApiCatalogModal open={apiCatalogOpen} onClose={() => setApiCatalogOpen(false)} />
    </div>
  );
};

export default MainComponent;
