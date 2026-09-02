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
ALTER TABLE public.sismos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_publicados ENABLE ROW LEVEL SECURITY;

-- 4. Políticas de Acceso:
-- Permitir lectura pública a cualquier usuario de la web (rol 'anon' y 'authenticated')
CREATE POLICY "Lectura pública de sismos" 
ON public.sismos 
FOR SELECT 
TO anon, authenticated 
USING (true);

-- La inserción y modificación solo la realiza el servicio (Edge Functions con SERVICE_ROLE_KEY)
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

-- Habilitar Realtime para la tabla sismos (actualización en vivo para el dashboard)
ALTER PUBLICATION supabase_realtime ADD TABLE public.sismos;
