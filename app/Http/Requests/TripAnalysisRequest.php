<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class TripAnalysisRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return ['mode' => ['required', Rule::in(['driving'])],
            'start' => ['required', 'array:lon,lat,road'], 'start.lon' => ['required', 'numeric', 'between:-180,180'], 'start.lat' => ['required', 'numeric', 'between:-90,90'],
            'places' => ['required', 'array', 'min:1', 'max:3', 'list'], 'places.*' => ['required', 'array:lon,lat,label,road'],
            'places.*.lon' => ['required', 'numeric', 'between:-180,180'], 'places.*.lat' => ['required', 'numeric', 'between:-90,90'],
            'start.road' => ['sometimes', 'array:lon,lat'], 'start.road.lon' => ['required_with:start.road', 'numeric', 'between:-180,180'], 'start.road.lat' => ['required_with:start.road', 'numeric', 'between:-90,90'],
            'places.*.road' => ['sometimes', 'array:lon,lat'], 'places.*.road.lon' => ['required_with:places.*.road', 'numeric', 'between:-180,180'], 'places.*.road.lat' => ['required_with:places.*.road', 'numeric', 'between:-90,90'],
            'places.*.label' => ['nullable', 'string', 'max:80']];
    }
}
