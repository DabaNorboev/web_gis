<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class TransportAnalysisRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'lon' => ['required', 'numeric', 'between:-180,180'],
            'radius_m' => ['sometimes', 'integer', 'in:300,500'],
            'lat' => ['required', 'numeric', 'between:-90,90'],
        ];
    }
}
