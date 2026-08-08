// The tracer. Development only -- it writes files to disk, which cannot work on
// Vercel, and map authoring has no business in a production bundle.
//
//   /tracer            wheatley level 1
//   /tracer?floor=2    wheatley level 2

import { notFound } from 'next/navigation';
import TracerCanvas from './TracerCanvas';

export const metadata = { title: 'Tracer' };

export default async function TracerPage({
  searchParams,
}: {
  searchParams: Promise<{ building?: string; floor?: string }>;
}) {
  if (process.env.NODE_ENV !== 'development') notFound();

  const params = await searchParams;
  const building = params.building ?? 'wheatley';
  const floor = parseInt(params.floor ?? '1', 10);

  return <TracerCanvas building={building} floor={floor} />;
}
