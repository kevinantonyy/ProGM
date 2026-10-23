import { useEffect, useState } from 'react';
import api from './api';
import { loadEspnAvailability } from '../utils/espnAvailability.js';

/** { loading, available, message }. Fails closed: until the server says ESPN is available, it is not. */
export default function useEspnAvailability() {
  const [state, setState] = useState({ loading: true, available: false, message: '' });
  useEffect(() => {
    let live = true;
    loadEspnAvailability(() => api.get('/espn/availability').then((response) => response.data)).then((result) => { if (live) setState({ loading: false, ...result }); });
    return () => { live = false; };
  }, []);
  return state;
}
