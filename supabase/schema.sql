-- ============================================================
--  ESQUEMA SUPABASE — SISMO·MONITOR
-- ============================================================
--  Ejecuta este script en el SQL Editor de tu proyecto Supabase.
-- ============================================================

-- 1. Tabla principal de sismos (Catálogo histórico)
CREATE TABLE IF NOT EXISTS public.sismos (
    id TEXT PRIMARY KEY,                       -- 'fv-...', 'us...', 'em-...'
    fuente TEXT NOT NULL,                      -- 'FUNVISIS', 'USGS', 'EMSC'
    fecha_hora_utc TIMESTAMPTZ NOT NULL,       -- Fecha y hora estandarizada UTC
    magnitud NUMERIC(3, 1) NOT NULL,           -- Ej: 4.2
    lat DOUBLE PRECISION NOT NULL,             -- Latitud (-90 a 90)
    lon DOUBLE PRECISION NOT NULL,             -- Longitud (-180 a 180)
    profundidad_km NUMERIC(5, 1) DEFAULT 0,    -- Profundidad en km
    lugar TEXT NOT NULL DEFAULT '—',           -- Descripción del lugar
    pais TEXT DEFAULT 'Venezuela',             -- País normalizado
    tsunami BOOLEAN DEFAULT FALSE,             -- Flag de información de tsunami
    pager TEXT,                                -- Nivel PAGER: green, yellow, orange, red
    felt INTEGER,                              -- Reportes ciudadanos
    url TEXT,                                  -- Enlace a la fuente
    registrado_en TIMESTAMPTZ DEFAULT NOW()    -- Timestamp de inserción
);

-- Índices de alto rendimiento para consultas web y análisis histórico
CREATE INDEX IF NOT EXISTS idx_sismos_fecha_hora ON public.sismos (fecha_hora_utc DESC);
CREATE INDEX IF NOT EXISTS idx_sismos_mag ON public.sismos (magnitud);
CREATE INDEX IF NOT EXISTS idx_sismos_fuente ON public.sismos (fuente);
CREATE INDEX IF NOT EXISTS idx_sismos_lat_lon ON public.sismos (lat, lon);

-- 2. Tabla de deduplicación de alertas en Telegram
CREATE TABLE IF NOT EXISTS public.telegram_publicados (
    id TEXT PRIMARY KEY,
    sismo_id TEXT REFERENCES public.sismos(id) ON DELETE SET NULL,
    fecha_hora_utc TIMESTAMPTZ NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    magnitud NUMERIC(3, 1) NOT NULL,
    enviado_en TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_pub_fecha ON public.telegram_publicados (fecha_hora_utc DESC);

-- 3. Habilitar Seguridad por Fila (RLS)
-- 3. Tabla para reportes comunitarios "¿Lo sentiste?" (Intensidad Mercalli MMI)
CREATE TABLE IF NOT EXISTS public.reportes_sentidos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sismo_id TEXT NOT NULL REFERENCES public.sismos(id) ON DELETE CASCADE,
    intensidad TEXT NOT NULL,                  -- 'debil', 'leve', 'moderado', 'fuerte'
    intensidad_mmi INTEGER NOT NULL DEFAULT 2, -- 2, 3, 5, 7 (Mercalli)
    lat DOUBLE PRECISION,
    lon DOUBLE PRECISION,
    ciudad TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reportes_sismo_id ON public.reportes_sentidos (sismo_id);
CREATE INDEX IF NOT EXISTS idx_reportes_fecha ON public.reportes_sentidos (created_at DESC);

-- Habilitar Seguridad por Fila (RLS)
ALTER TABLE public.sismos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_publicados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reportes_sentidos ENABLE ROW LEVEL SECURITY;

-- 4. Políticas de Acceso:
CREATE POLICY "Lectura pública de sismos" 
ON public.sismos 
FOR SELECT 
TO anon, authenticated 
USING (true);

CREATE POLICY "Escritura interna para Edge Functions en sismos" 
ON public.sismos 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

CREATE POLICY "Control interno de alertas Telegram" 
ON public.telegram_publicados 
FOR ALL 
TO service_role 
USING (true) 
WITH CHECK (true);

CREATE POLICY "Permitir crear reportes sentidos a usuarios" 
ON public.reportes_sentidos 
FOR INSERT 
TO anon, authenticated 
WITH CHECK (true);

CREATE POLICY "Lectura pública de reportes sentidos" 
ON public.reportes_sentidos 
FOR SELECT 
TO anon, authenticated 
USING (true);

-- Habilitar Realtime para sismos y reportes comunitarios
ALTER PUBLICATION supabase_realtime ADD TABLE public.sismos;
ALTER PUBLICATION supabase_realtime ADD TABLE public.reportes_sentidos;

