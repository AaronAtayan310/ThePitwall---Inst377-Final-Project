const express = require('express');
const bodyParser = require('body-parser');
const supabaseClient = require('@supabase/supabase-js');
const { isValidStateAbbreviation } = require('usa-state-validator');
const dotenv = require('dotenv');

const app = express();
const port = 3000;
dotenv.config()

app.use(bodyParser.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = supabaseClient.createClient(supabaseUrl, supabaseKey);

app.get('/customers', (req, res) => {
    console.log('Attempting to get all customers');

    const { data, error } = supabase.from('customer').select();

    if (error) {
        console.log(`Error: ${error}`);
        res.statusCode = 500;
        res.send(error);
    } else {
        console.log('Received Data: ', data);
        res.json(data)
    }
});

app.post('/customer', async (req, res) => {
    console.log('Adding customer');
    console.log(`Request: ${JSON.stringify(req.body)}`);

    const firstName = req.body.firstName;
    const lastName = req.body.lastName;

    const { data, error } = supabase.from('customer').insert({
        customer_first_name: firstName,
        customer_last_name: lastName,
    })
    .select();

    res.json(data);
});

app.listen(port, () => {
    console.log(`App is available on port: ${port}`);
});

