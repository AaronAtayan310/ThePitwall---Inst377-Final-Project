import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch'; // Required if using Node.js versions below v18

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Supabase Connection (25 pts)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("CRITICAL ERROR: Supabase environment variables are missing!");
    process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);


/* =========================================================================
   ENDPOINT 1: GET External Provider Data (OpenF1 API Proxy / Routing)
   Matches Requirement: 1 Must get data from some external provider
   ========================================================================= */
app.get('/api/openf1/:endpoint', async (req, res) => {
    try {
        const targetEndpoint = req.params.endpoint;
        
        // Reconstruct the full query string passed from your front-end
        const queryString = new URLSearchParams(req.query).toString();
        const externalUrl = `https://api.openf1.org/v1/${targetEndpoint}?${queryString}`;

        console.log(`[Proxy Request] Fetching: ${externalUrl}`);

        const openF1Response = await fetch(externalUrl);
        const data = await openF1Response.json();
        
        res.json(data);
    } catch (err) {
        console.error("OpenF1 Proxy Failure:", err);
        res.status(500).json({ error: "Failed to fetch data from OpenF1 external provider." });
    }
});


/* =========================================================================
   ENDPOINT 2: POST Data to your DB (Save Favorite Driver/Telemetry Marker)
   Matches Requirement: 1 Must Write Data to your DB
   ========================================================================= */
app.post('/api/favorites', async (req, res) => {
    const { driver_number, driver_name, team_name } = req.body;

    if (!driver_number || !driver_name) {
        return res.status(400).json({ error: "Missing required fields: driver_number and driver_name" });
    }

    try {
        const { data, error } = await supabase
            .from('driver_favorites')
            .insert([{ driver_number, driver_name, team_name }])
            .select();

        if (error) throw error;

        res.status(201).json({ message: "Successfully saved to database!", favorite: data[0] });
    } catch (err) {
        console.error("Database Write Error:", err);
        res.status(500).json({ error: "Failed to write data to Supabase database." });
    }
});


/* =========================================================================
   ENDPOINT 3: GET Data from your DB (Retrieve Saved Favorites Layout)
   Matches Requirement: 1 Must Retrieve Data from your database
   ========================================================================= */
app.get('/api/favorites', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('driver_favorites')
            .select('*')
            .order('saved_at', { ascending: false });

        if (error) throw error;

        res.json(data);
    } catch (err) {
        console.error("Database Read Error:", err);
        res.status(500).json({ error: "Failed to retrieve data from Supabase database." });
    }
});


// Start server listener
app.listen(PORT, () => {
    console.log(`ThePitwall Backend Framework running flawlessly on port ${PORT}`);
});