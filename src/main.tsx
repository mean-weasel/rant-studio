import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ProductionIntake } from './ProductionIntake';
import './styles.css';

const mode = new URLSearchParams(window.location.search).get('mode');

createRoot(document.getElementById('root')!).render(
  mode === 'intake' ? <ProductionIntake /> : <App />,
);
